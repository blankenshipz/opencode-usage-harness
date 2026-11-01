import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.dispatch_runtime import completion_receipt, intent_sources, sessions
from src.paths import opencode_db, ownership_dir, quota_cache_path, state_dir


class DispatchRuntimeTest(unittest.TestCase):
    def fixture(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "opencode.db"
        with sqlite3.connect(db) as connection:
            connection.executescript(
                "create table session_v2 (id text, parent_id text, agent text, directory text, time_suspended integer, time_created integer, title text);"
                "create table session_message (id text, session_id text, type text, seq integer, data text);"
            )
            connection.execute("insert into session_v2 values ('root', null, 'router', 'workspace', null, 1, 'private prompt')")
            connection.executemany(
                "insert into session_message values (?, 'root', 'user', ?, ?)",
                [("source", 1, json.dumps({"text": "work"})), ("continuation", 2, json.dumps({"text": "Continue working toward the active session goal."}))],
            )
        return db

    def test_activity_does_not_eagerly_decode_historical_payloads_after_context(self):
        db = self.fixture()
        latest = {"time": {"created": 90, "completed": 100}, "tokens": {"input": 20, "output": 5}, "content": [{"type": "text", "text": "latest"}]}
        with sqlite3.connect(db) as connection:
            connection.execute("insert into session_message values ('msg_old', 'root', 'assistant', 3, ?)", (json.dumps({"content": [{"type": "text", "text": "old" * 100000}]}),))
            connection.execute("insert into session_message values ('msg_latest', 'root', 'assistant', 4, ?)", (json.dumps(latest),))
        from src import dispatch_runtime
        visited = []
        original = dispatch_runtime._native_activity
        def observe(rows):
            visited.extend(message_id for message_id, _ in rows)
            return original(rows)
        with patch.object(dispatch_runtime, "_native_activity", side_effect=observe):
            result = sessions(db_path=db)[0]
        self.assertEqual(visited, ["msg_latest"])
        self.assertEqual(result["activity"]["scope"], "latest_assistant_through_latest_valid_context")
        self.assertEqual(result["lastVisibleTextAt"], 100)

    def test_explicit_database_and_source_ids_only(self):
        db = self.fixture()
        self.assertEqual(intent_sources("root", db_path=db), ["source"])
        result = sessions(db_path=db)
        self.assertEqual(result[0]["id"], "root")
        self.assertNotIn("title", result[0])
        self.assertEqual(result[0]["directory"], "workspace")
        self.assertFalse(result[0]["active"])
        with sqlite3.connect(db) as connection:
            connection.execute("update session_v2 set time_suspended=123")
        self.assertTrue(sessions(db_path=db)[0]["active"])

    def test_runtime_projection_retains_only_model_context_and_canonical_identity(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("alter table session_v2 add column model text")
            connection.execute("alter table session_v2 add column metadata text")
            connection.execute("update session_v2 set model=?,metadata=?", (json.dumps({"id":"balanced","providerID":"demo","variant":"medium","private":"SECRET"}), json.dumps({"private":"SECRET","harnessMigration":{"historical":True,"canonicalSessionID":"original"}})))
            connection.execute("insert into session_message values ('assistant','root','assistant',3,?)", (json.dumps({"time":{"completed":3},"tokens":{"input":200,"cache":{"read":120000}},"content":[{"type":"text","text":"SECRET"}]}),))
        result = sessions(db_path=db)[0]
        self.assertEqual(result["model"], {"id":"balanced","providerID":"demo","variant":"medium"})
        self.assertEqual(result["contextTokens"], 120200)
        self.assertEqual(result["canonicalSessionID"], "original")
        self.assertNotIn("SECRET", json.dumps(result))

    def test_context_usage_uses_latest_completed_valid_observation_and_preserves_newest_binding(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.executemany(
                "insert into session_message values (?, 'root', 'assistant', ?, ?)",
                [
                    ("completed", 3, json.dumps({"time": {"completed": 30}, "tokens": {"input": 4, "cache": {"read": 5, "write": 6}}})),
                    ("inflight", 4, json.dumps({"tokens": {"input": 99}})),
                ],
            )
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastAssistantID"], "inflight")
        self.assertEqual(result["contextTokens"], 15)
        self.assertEqual(result["contextObservedAt"], 30)
        self.assertEqual(result["contextMessageID"], "completed")

    def test_context_model_comes_from_the_completed_observation(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("alter table session_v2 add column model text")
            connection.execute("update session_v2 set model=?", (json.dumps({"providerID": "demo", "id": "current"}),))
            connection.executemany(
                "insert into session_message values (?, 'root', 'assistant', ?, ?)",
                [
                    ("old", 3, json.dumps({"time": {"completed": 30}, "tokens": {"input": 4}, "model": {"providerID": "demo", "id": "observed", "variant": "medium", "secret": "drop"}})),
                    ("new", 4, json.dumps({"tokens": {"input": 99}, "model": {"providerID": "demo", "id": "inflight"}})),
                ],
            )
        result = sessions(db_path=db)[0]
        self.assertEqual(result["contextTokens"], 4)
        self.assertEqual(result["contextMessageID"], "old")
        self.assertEqual(result["contextModel"], {"providerID": "demo", "id": "observed", "variant": "medium"})

    def test_context_model_malformed_does_not_change_context_observation(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.executemany(
                "insert into session_message values (?, 'root', 'assistant', ?, ?)",
                [
                    ("bad-model", 3, json.dumps({"time": {"completed": 30}, "tokens": {"input": 4}, "model": {"providerID": "demo", "id": 42}})),
                ],
            )
        result = sessions(db_path=db)[0]
        self.assertEqual(result["contextTokens"], 4)
        self.assertEqual(result["contextMessageID"], "bad-model")
        self.assertNotIn("contextModel", result)

    def test_native_activity_is_bounded_closed_set_and_applies_to_children(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("insert into session_v2 values ('child', 'root', 'builder', 'workspace', null, 2, 'private child')")
            completed = {
                "time": {"completed": 20},
                "finish": "stop",
                "content": [
                    {"type": "text", "text": "SECRET response"},
                    {"type": "tool", "id": "shell-1", "name": "shell", "state": {"status": "completed", "time": {"created": 10, "completed": 15}, "exitCode": 0}},
                    {"type": "tool", "id": "opaque-1", "name": "execute", "state": {"status": "completed", "time": {"created": 16, "completed": 19}, "metadata": {"timeout": True}, "input": {"command": "SECRET"}}},
                ],
            }
            active = {
                "time": {"created": 30},
                "content": [
                    {"type": "tool", "id": "z", "name": "read", "state": {"status": "streaming", "time": {"created": 31}, "input": {"path": "/SECRET"}}},
                    {"type": "tool", "id": "a", "name": "grep", "state": {"status": "streaming", "time": {"created": 32}}},
                    {"type": "tool", "id": "b", "name": "custom-secret", "state": {"status": "streaming", "time": {"created": 33}}},
                    {"type": "tool", "id": "c", "name": "shell", "state": {"status": "streaming", "time": {"created": 34}}},
                ],
            }
            child_stale = {"time": {"created": 40}, "content": [{"type": "tool", "id": "stale", "name": "shell", "state": {"status": "streaming", "time": {"created": 41}}}]}
            child_answer = {"time": {"completed": 50}, "finish": "stop", "content": [{"type": "text", "text": "child SECRET"}]}
            connection.executemany(
                "insert into session_message values (?, ?, 'assistant', ?, ?)",
                [("root-done", "root", 3, json.dumps(completed)), ("root-active", "root", 4, json.dumps(active)), ("child-stale", "child", 2, json.dumps(child_stale)), ("child-done", "child", 3, json.dumps(child_answer))],
            )
        result = {row["id"]: row for row in sessions(db_path=db)}
        root = result["root"]
        self.assertEqual(root["activity"]["lastModelResponseAt"], 20)
        self.assertEqual(root["lastVisibleTextAt"], 20)
        self.assertEqual([tool["toolID"] for tool in root["activity"]["runningTools"]], ["a", "b", "c"])
        self.assertEqual(root["activity"]["runningTools"][1]["name"], "other")
        self.assertEqual(root["activity"]["lastCompletedTool"], {"name": "other", "status": "completed", "messageID": "root-done", "toolID": "opaque-1", "startedAt": 16, "completedAt": 19, "timedOut": True})
        self.assertNotIn("SECRET", json.dumps(root))
        self.assertEqual(result["child"]["lastVisibleTextAt"], 50)
        self.assertEqual(result["child"]["activity"]["runningTools"], [])
        for variant in (42, None, ""):
            with self.subTest(variant=variant), sqlite3.connect(db) as connection:
                connection.execute("update session_message set data=? where id='bad-model'", (json.dumps({"time": {"completed": 30}, "tokens": {"input": 4}, "model": {"providerID": "demo", "id": "observed", "variant": variant}}),))
            self.assertNotIn("contextModel", sessions(db_path=db)[0])

    def test_context_usage_omits_unknown_invalid_and_precompaction_observations(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("insert into session_message values ('old','root','assistant',3,?)", (json.dumps({"time": {"completed": 3}, "tokens": {"input": 10}}),))
            connection.execute("insert into session_message values ('compact','root','compaction',4,?)", (json.dumps({"reason": "manual", "status": "completed"}),))
            connection.execute("insert into session_message values ('bad','root','assistant',5,?)", (json.dumps({"time": {"completed": 5}, "tokens": {"input": float('nan')}}),))
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastAssistantID"], "bad")
        self.assertNotIn("contextTokens", result)
        self.assertNotIn("contextObservedAt", result)
        self.assertNotIn("contextMessageID", result)

    def test_context_usage_keeps_successful_auto_boundary_past_newer_manual_failure(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("insert into session_message values ('old','root','assistant',3,?)", (json.dumps({"time": {"completed": 3}, "tokens": {"input": 10}}),))
            connection.execute("insert into session_message values ('auto','root','compaction',4,?)", (json.dumps({"reason": "auto", "status": "completed"}),))
            connection.execute("insert into session_message values ('manual-failed','root','compaction',5,?)", (json.dumps({"reason": "manual", "status": "failed"}),))
            connection.execute("insert into session_message values ('new','root','assistant',6,?)", (json.dumps({"time": {"completed": 6}, "tokens": {"input": 7}}),))
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastCompaction"], {"id": "manual-failed", "status": "failed"})
        self.assertEqual(result["contextTokens"], 7)
        self.assertEqual(result["contextMessageID"], "new")

    def test_context_usage_scan_is_bounded_and_reports_unknown(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.execute("insert into session_message values ('old','root','assistant',3,?)", (json.dumps({"time": {"completed": 3}, "tokens": {"input": 10}}),))
            connection.executemany(
                "insert into session_message values (?, 'root', 'assistant', ?, ?)",
                [(f"invalid-{seq}", seq, json.dumps({"time": {"completed": seq}, "tokens": {"input": -1}})) for seq in range(4, 68)],
            )
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastAssistantID"], "invalid-67")
        self.assertNotIn("contextTokens", result)

    def test_context_usage_accepts_true_zero_and_rejects_failed_or_cancelled(self):
        db = self.fixture()
        with sqlite3.connect(db) as connection:
            connection.executemany(
                "insert into session_message values (?, 'root', 'assistant', ?, ?)",
                [
                    ("valid-zero", 3, json.dumps({"finish": "stop", "time": {"completed": 3}, "tokens": {"input": 0, "cache": {"read": 0, "write": 0}}})),
                    ("cancelled", 4, json.dumps({"finish": "cancelled", "time": {"completed": 4}, "tokens": {"input": 99}})),
                ],
            )
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastAssistantID"], "cancelled")
        self.assertEqual(result["contextTokens"], 0)

    def test_defaults_are_state_dir_and_database_is_required(self):
        with patch.dict(os.environ, {"HARNESS_STATE_DIR": "/tmp/harness-state"}, clear=True):
            self.assertEqual(state_dir(), Path("/tmp/harness-state"))
            self.assertEqual(quota_cache_path(), Path("/tmp/harness-state/quota/cache.json"))
            self.assertEqual(ownership_dir(), Path("/tmp/harness-state/dispatch-ownership"))
            with self.assertRaisesRegex(RuntimeError, "HARNESS_OPENCODE_DB"):
                opencode_db()

    def test_completion_receipt_requires_one_exact_prompt_terminal_assistant_and_idle(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup); db = Path(tmp.name) / "opencode.db"
        marker = "marker-1"; text = f"work\nDispatch completion marker: {marker}"; digest = __import__('hashlib').sha256(text.encode()).hexdigest()
        with sqlite3.connect(db) as c:
            c.executescript("create table session_v2 (id text, idle_outcome text); create table session_message (id text,session_id text,type text,seq integer,data text); create table session_inbox (id text,session_id text,type text,payload text,delivery text,enqueued_seq integer,time_created integer);")
            c.execute("insert into session_v2 values ('child','succeeded')")
            c.executemany("insert into session_message values (?,?,?,?,?)", [("prompt","child","user",1,json.dumps({"text":text})), ("answer","child","assistant",2,json.dumps({"finish":"stop","time":{"completed":2},"content":[{"type":"text","text":"done"}]})), ("idle","child","idle",3,json.dumps({"outcome":"succeeded"}))])
        self.assertEqual(completion_receipt("child",marker,digest,db_path=db), {"promptID":"prompt","assistantID":"answer","assistantSeq":2,"idleID":"idle","idleSeq":3})
        for clock in (True, -1, float('inf'), "300", None):
            with sqlite3.connect(db) as c: c.execute("update session_message set data=? where id='idle'", (json.dumps({"outcome":"succeeded", "time":{"created":clock}}),))
            self.assertNotIn("completedAt", completion_receipt("child",marker,digest,db_path=db))
        with sqlite3.connect(db) as c: c.execute("update session_message set data=? where id='idle'", (json.dumps({"outcome":"succeeded", "time":{"created":300}}),))
        self.assertEqual(completion_receipt("child",marker,digest,db_path=db)["completedAt"], 300)
        with sqlite3.connect(db) as c: c.execute("insert into session_message values (?,?,?,?,?)", ("later","child","user",4,json.dumps({"text":"later"})))
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=db))

    def test_recovered_provider_receipts_require_native_retry_and_exact_boundaries(self):
        from copy import deepcopy
        marker = "recovered-generation"; prompt = "work " + marker
        digest = __import__('hashlib').sha256(prompt.encode()).hexdigest()
        identity = {"agent":"harness-builder", "model":{"providerID":"openai", "id":"fixture", "variant":"medium"}}
        error = {"type":"provider.transport", "message":"PRIVATE provider error", "response":{"delivery":"accepted"}}
        failed = {**deepcopy(identity), "finish":"error", "time":{"completed":2}, "error":error,
                  "retry":{"attempt":2, "at":3, "error":deepcopy(error)}}
        synthetic = {"text":"The previous response was interrupted. Continue from where you left off without repeating completed content."}
        answer = {**deepcopy(identity), "finish":"stop", "time":{"completed":5}, "content":[{"type":"text", "text":"PRIVATE answer"}]}
        base = [("failed","assistant",failed),("recovery","synthetic",synthetic),("answer","assistant",answer),("idle","idle",{"outcome":"succeeded", "time":{"created":6}})]
        def read(rows, pending=False):
            tmp=tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup); db=Path(tmp.name)/"opencode.db"
            with sqlite3.connect(db) as c:
                c.executescript("create table session_v2 (id text, idle_outcome text); create table session_message (id text,session_id text,type text,seq integer,data text); create table session_inbox (id text,session_id text,type text,payload text,delivery text,enqueued_seq integer,time_created integer);")
                c.execute("insert into session_v2 values ('child','succeeded')")
                c.execute("insert into session_message values ('prompt','child','user',1,?)",(json.dumps({"text":prompt}),))
                c.executemany("insert into session_message values (?,'child',?,?,?)",[(i,t,n+2,json.dumps(d)) for n,(i,t,d) in enumerate(rows)])
                if pending: c.execute("insert into session_inbox values ('pending','child','message','{}','queued',1,1)")
            return completion_receipt("child",marker,digest,db_path=db)
        receipt=read(base)
        self.assertEqual(receipt["assistantID"],"answer")
        self.assertEqual(receipt["recoveredProviderErrors"],[{"errorID":"failed","recoveryID":"recovery","type":"provider.transport","attempt":2}])
        self.assertNotIn("PRIVATE",json.dumps(receipt))
        internal=deepcopy(base);internal[0][2]["error"]["type"]="provider.internal";internal[0][2]["retry"]["error"]=deepcopy(internal[0][2]["error"])
        self.assertIsNotNone(read(internal))
        shell=deepcopy(base);shell.insert(2,("shell","synthetic",{"text":"retained shell result"}));self.assertIsNotNone(read(shell))
        tool=deepcopy(base);tool.insert(2,("tool","assistant",{**identity,"finish":"tool-calls","time":{"completed":4},"content":[]}));self.assertIsNotNone(read(tool))
        rejected=[]
        for key in ["retry", "model", "agent"]:
            rows=deepcopy(base);del rows[0][2][key];rejected.append(rows)
        for field,value in [("attempt",True),("attempt",1),("at",True),("at",1),("error",{"type":"provider.auth"})]:
            rows=deepcopy(base);rows[0][2]["retry"][field]=value;rejected.append(rows)
        for status in [400,401,402,403,408,429,True,"503"]:
            rows=deepcopy(base);rows[0][2]["error"]["status"]=status;rows[0][2]["retry"]["error"]=deepcopy(rows[0][2]["error"]);rejected.append(rows)
        for kind in ["provider.auth","provider.quota","provider.rate-limit","provider.unknown","permission.denied","subscription.guard"]:
            rows=deepcopy(base);rows[0][2]["error"]["type"]=kind;rows[0][2]["retry"]["error"]=deepcopy(rows[0][2]["error"]);rejected.append(rows)
        for finish in ["cancelled","aborted"]:
            rows=deepcopy(base);rows[0][2]["finish"]=finish;rejected.append(rows)
        for key in ["agent","providerID","id","variant"]:
            rows=deepcopy(base)
            if key=="agent":rows[2][2][key]="other"
            else:rows[2][2]["model"][key]="other"
            rejected.append(rows)
        for kind in ["user","compaction","model-switched","agent-switched","location-switched"]:
            rows=deepcopy(base);rows.insert(2,("boundary",kind,{}));rejected.append(rows)
        for outcome in ["failed","interrupted"]:
            rows=deepcopy(base);rows.insert(2,("earlier-idle","idle",{"outcome":outcome}));rejected.append(rows)
        rows=deepcopy(base);rows[1][2]["text"]="not a native recovery";rejected.append(rows)
        rows=deepcopy(base);rows.insert(1,("shell-before-recovery","synthetic",{"text":"unrelated"}));rejected.append(rows)
        rows=deepcopy(base);rows[2][2]["content"]=[];rejected.append(rows)
        rows=deepcopy(base);del rows[2][2]["time"];rejected.append(rows)
        rows=deepcopy(base);rows[2][2]["finish"]="tool-calls";rejected.append(rows)
        rows=deepcopy(base);rows.append(("later","assistant",answer));rejected.append(rows)
        rows=deepcopy(base);rows[3][2]["outcome"]="failed";rejected.append(rows)
        for kind in ["system", "synthetic", "shell", "idle"]:
            rows=deepcopy(base);rows.insert(3,("after-answer",kind,{"outcome":"succeeded"}));rejected.append(rows)
            rows=deepcopy(base);rows.append(("after-idle",kind,{"outcome":"succeeded"}));rejected.append(rows)
        for index,rows in enumerate(rejected):
            with self.subTest(invalid_chain=index):self.assertIsNone(read(rows))
        self.assertIsNone(read(base,pending=True))
        for count in (8,9):
            repeated=[]
            for n in range(count):repeated.extend([(f"error-{n}","assistant",deepcopy(failed)),(f"recovery-{n}","synthetic",synthetic)])
            result=read(repeated+base[2:])
            self.assertEqual(result is not None,count==8)

    def test_completion_receipt_rejects_tool_error_cancel_compaction_pending_and_ambiguous_prompt(self):
        marker="marker-2"; text=f"work\nDispatch completion marker: {marker}"; digest=__import__('hashlib').sha256(text.encode()).hexdigest()
        def make(assistant, extra=None, inbox=None, duplicate=False):
            tmp=tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup); db=Path(tmp.name)/"opencode.db"
            with sqlite3.connect(db) as c:
                c.executescript("create table session_v2 (id text, idle_outcome text); create table session_message (id text,session_id text,type text,seq integer,data text); create table session_inbox (id text,session_id text,type text,payload text,delivery text,enqueued_seq integer,time_created integer);")
                c.execute("insert into session_v2 values ('child','succeeded')")
                rows=[("prompt","child","user",1,json.dumps({"text":text})),("answer","child","assistant",2,json.dumps(assistant)),("idle","child","idle",3,json.dumps({"outcome":"succeeded"}))]
                if extra: rows.append(extra)
                if duplicate: rows.insert(1,("prompt2","child","user",1,json.dumps({"text":text})))
                c.executemany("insert into session_message values (?,?,?,?,?)",rows)
                if inbox: c.execute("insert into session_inbox values ('queued','child','message',?,'queued',1,1)",(json.dumps({"text":text}),))
            return db
        bad=[{"finish":"stop","time":{"completed":2},"content":[{"type":"tool","name":"read"}]}, {"finish":"error","time":{"completed":2},"content":[{"type":"text","text":"no"}]}, {"finish":"cancelled","time":{"completed":2},"content":[{"type":"text","text":"no"}]}]
        for assistant in bad: self.assertIsNone(completion_receipt("child",marker,digest,db_path=make(assistant)))
        good={"finish":"stop","time":{"completed":2},"content":[{"type":"text","text":"done"}]}
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=make(good,("compact","child","compaction",4,json.dumps({})))) )
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=make(good,inbox=True)))
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=make(good,duplicate=True)))
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=make(good,("later-tool","child","assistant",4,json.dumps({"finish":"tool-calls","time":{"completed":4},"content":[]})))))
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=make({"finish":"stop","content":[{"type":"text","text":"done"}]})))


if __name__ == "__main__":
    unittest.main()

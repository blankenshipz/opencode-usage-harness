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
        with sqlite3.connect(db) as c: c.execute("insert into session_message values (?,?,?,?,?)", ("later","child","user",4,json.dumps({"text":"later"})))
        self.assertIsNone(completion_receipt("child",marker,digest,db_path=db))

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

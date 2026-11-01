import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from src.dispatch_runtime import sessions, terminal_receipt


class TerminalRuntimeTest(unittest.TestCase):
    def make_db(self, rows, *, idle_outcome="succeeded", suspended=None, compacting=None, queued=False, root=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db = Path(tmp.name) / "opencode.db"
        prompt = "work\nDispatch completion marker: marker"
        with sqlite3.connect(db) as c:
            c.executescript(
                "create table session_v2 (id text, parent_id text, agent text, directory text, time_suspended, time_created integer, idle_outcome text, time_compacting);"
                "create table session_message (id text, session_id text, type text, seq integer, data text);"
                "create table session_inbox (id text, session_id text, type text, payload text, delivery text, enqueued_seq integer, time_created integer);"
            )
            c.execute("insert into session_v2 values (?,?,?,?,?,?,?,?)", ("root", None if root else "parent", "agent", "dir", suspended, 1, idle_outcome, compacting))
            c.execute("insert into session_message values (?,?,?,?,?)", ("prompt", "root", "user", 1, json.dumps({"text": prompt})))
            c.executemany("insert into session_message values (?,?,?,?,?)", [(ident, "root", kind, seq, json.dumps(data)) for seq, (ident, kind, data) in enumerate(rows, 2)])
            if queued:
                c.execute("insert into session_inbox values ('queued','root','message','{}','queued',1,1)")
        return db, prompt

    def receipt(self, db, prompt):
        digest = hashlib.sha256(prompt.encode()).hexdigest()
        return terminal_receipt("root", "marker", digest, db_path=db)

    def test_success_sanitizes_and_requires_exact_terminal_chain(self):
        db, prompt = self.make_db([
            ("answer", "assistant", {"finish": "stop", "time": {"completed": 2}, "content": [{"type": "text", "text": "SECRET result"}], "reasoning": "PRIVATE"}),
            ("idle", "idle", {"outcome": "succeeded", "time": {"created": 3}}),
        ])
        result = self.receipt(db, prompt)
        self.assertEqual(result, {"promptID": "prompt", "assistantID": "answer", "assistantSeq": 2, "idleID": "idle", "idleSeq": 3, "outcome": "succeeded", "completedAt": 3})
        self.assertNotIn("SECRET", json.dumps(result))
        with sqlite3.connect(db) as c:
            c.execute("insert into session_message values ('later','root','system',4,'{}')")
        self.assertIsNone(self.receipt(db, prompt))

    def test_prompt_hash_and_generation_boundaries_are_strict(self):
        rows = [("answer", "assistant", {"finish": "stop", "time": {"completed": 2}, "content": [{"type": "text", "text": "ok"}]}), ("idle", "idle", {"outcome": "succeeded"})]
        db, prompt = self.make_db(rows)
        self.assertIsNone(terminal_receipt("root", "marker", "bad-hash", db_path=db))
        with sqlite3.connect(db) as c:
            c.execute("insert into session_message values ('duplicate','root','user',4,?)", (json.dumps({"text": prompt}),))
        digest = hashlib.sha256(prompt.encode()).hexdigest()
        self.assertIsNone(terminal_receipt("root", "marker", f"{digest},{digest}", db_path=db))
        for kind in ("user", "compaction", "model-switched", "agent-switched", "location-switched"):
            db, prompt = self.make_db(rows + [("boundary", kind, {})])
            self.assertIsNone(self.receipt(db, prompt))

    def test_failed_gate_can_settle_without_assistant(self):
        db, prompt = self.make_db([("idle", "idle", {"outcome": "failed", "time": {"created": 4}}),], idle_outcome="failed")
        self.assertEqual(self.receipt(db, prompt)["outcome"], "failed")

    def test_cancelled_assistant_requires_agreeing_interrupted_idle(self):
        db, prompt = self.make_db([
            ("cancel", "assistant", {"finish": "cancelled", "time": {"completed": 2}, "content": []}),
            ("idle", "idle", {"outcome": "interrupted"}),
        ], idle_outcome="interrupted")
        self.assertEqual(self.receipt(db, prompt)["outcome"], "interrupted")
        db, prompt = self.make_db([("idle", "idle", {"outcome": "succeeded"})])
        self.assertIsNone(self.receipt(db, prompt))

    def test_tool_calls_may_precede_terminal_assistant_but_not_follow_one(self):
        tool = ("tool", "assistant", {"finish": "tool-calls", "content": []})
        failed = ("failed", "assistant", {"finish": "error", "time": {"completed": 2}, "error": {"type": "provider.internal"}})
        db, prompt = self.make_db([tool, ("idle", "idle", {"outcome": "failed"})], idle_outcome="failed")
        self.assertEqual(self.receipt(db, prompt)["outcome"], "failed")
        stop = ("stop", "assistant", {"finish": "stop", "time": {"completed": 2}, "content": [{"type": "text", "text": "ok"}]})
        db, prompt = self.make_db([tool, stop, ("idle", "idle", {"outcome": "succeeded"})])
        self.assertEqual(self.receipt(db, prompt)["outcome"], "succeeded")
        db, prompt = self.make_db([stop, ("tool-result", "synthetic", {"text": "result"}), ("idle", "idle", {"outcome": "succeeded"})])
        self.assertIsNone(self.receipt(db, prompt))

    def test_native_retry_recovery_requires_exact_chain_and_identity(self):
        identity = {"agent": "builder", "model": {"providerID": "demo", "id": "fixture", "variant": "medium"}}
        error = {"type": "provider.transport", "message": "private"}
        failed = {**identity, "finish": "error", "time": {"completed": 2}, "error": error, "retry": {"attempt": 2, "at": 3, "error": error}}
        synthetic = {"text": "The previous response was interrupted. Continue from where you left off without repeating completed content."}
        answer = {**identity, "finish": "stop", "time": {"completed": 5}, "content": [{"type": "text", "text": "private result"}]}
        db, prompt = self.make_db([("failed", "assistant", failed), ("recovery", "synthetic", synthetic), ("answer", "assistant", answer), ("idle", "idle", {"outcome": "succeeded"})])
        result = self.receipt(db, prompt)
        self.assertEqual(result["outcome"], "succeeded")
        self.assertNotIn("private", json.dumps(result).lower())
        wrong = {**answer, "model": {**identity["model"], "id": "other"}}
        db, prompt = self.make_db([("failed", "assistant", failed), ("recovery", "synthetic", synthetic), ("answer", "assistant", wrong), ("idle", "idle", {"outcome": "succeeded"})])
        self.assertIsNone(self.receipt(db, prompt))
        db, prompt = self.make_db([("failed", "assistant", {**failed, "error": {"type": "provider.auth"}, "retry": {**failed["retry"], "error": {"type": "provider.auth"}}}), ("idle", "idle", {"outcome": "failed"})], idle_outcome="failed")
        self.assertIsNone(self.receipt(db, prompt))

        final_failed = {**identity, "finish": "error", "time": {"completed": 5}, "error": {"type": "provider.transport"}}
        db, prompt = self.make_db([("failed", "assistant", failed), ("recovery", "synthetic", synthetic), ("final-failed", "assistant", final_failed), ("idle", "idle", {"outcome": "failed"})], idle_outcome="failed")
        self.assertEqual(self.receipt(db, prompt)["outcome"], "failed")

        def recovery_rows(count):
            rows = []
            for index in range(count):
                item = {**identity, "finish": "error", "time": {"completed": index + 2}, "error": error, "retry": {"attempt": index + 2, "at": index + 3, "error": error}}
                rows.extend([(f"failed-{index}", "assistant", item), (f"recovery-{index}", "synthetic", synthetic)])
            rows.append(("answer", "assistant", answer))
            rows.append(("idle", "idle", {"outcome": "succeeded"}))
            return rows

        db, prompt = self.make_db(recovery_rows(8))
        self.assertEqual(self.receipt(db, prompt)["outcome"], "succeeded")
        db, prompt = self.make_db(recovery_rows(9))
        self.assertIsNone(self.receipt(db, prompt))

    def test_active_pending_malformed_unknown_and_root_metadata_reject_or_bound(self):
        base = [("answer", "assistant", {"finish": "stop", "time": {"completed": 2}, "content": [{"type": "text", "text": "ok"}]}), ("idle", "idle", {"outcome": "succeeded"})]
        for kwargs in ({"suspended": 10}, {"compacting": 10}, {"queued": True}):
            db, prompt = self.make_db(base, **kwargs)
            self.assertIsNone(self.receipt(db, prompt))
        for rows in ([ ("idle", "idle", {"outcome": "mystery"}) ], [("bad", "assistant", {"finish": "stop", "time": {"completed": 2}, "content": "bad"}), ("idle", "idle", {"outcome": "succeeded"})]):
            db, prompt = self.make_db(rows)
            self.assertIsNone(self.receipt(db, prompt))
        db, _ = self.make_db([], root=True, suspended=123)
        self.assertEqual(sessions(db_path=db)[0]["executionStartedAt"], 123)
        with sqlite3.connect(db) as c:
            c.execute("insert into session_message values ('visible','root','assistant',2,?)", (json.dumps({"time": {"completed": 77}, "content": [{"type": "text", "text": "visible"}], "reasoning": "secret"}),))
        result = sessions(db_path=db)[0]
        self.assertEqual(result["lastVisibleTextAt"], 77)
        self.assertNotIn("secret", json.dumps(result))
        with sqlite3.connect(db) as c:
            c.execute("insert into session_message values ('reasoning','root','assistant',3,?)", (json.dumps({"time": {"completed": 99}, "content": [{"type": "reasoning", "text": "private"}]}),))
        self.assertEqual(sessions(db_path=db)[0]["lastVisibleTextAt"], 77)


if __name__ == "__main__":
    unittest.main()

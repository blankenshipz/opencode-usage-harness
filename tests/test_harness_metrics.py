import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from src.harness_metrics import collect_metrics


class HarnessMetricsTest(unittest.TestCase):
    def fixture(self):
        tmp = tempfile.TemporaryDirectory(); self.addCleanup(tmp.cleanup)
        root = Path(tmp.name); db = root / "metrics.db"
        c = sqlite3.connect(db)
        c.executescript("create table session_v2 (id text primary key, parent_id text, time_created integer, time_updated integer); create table session_message (id text primary key, session_id text, type text, seq integer, time_created integer, data text);")
        c.executemany("insert into session_v2 values (?,?,?,?)", [("root", None, 1000, 1000), ("child", "root", 1001, 900), ("other", None, 1000, 1000)])
        def add(mid, sid, when, data): c.execute("insert into session_message values (?,?,?,?,?,?)", (mid, sid, "assistant", 1, when, json.dumps(data)))
        add("old", "root", 1, {"agent": "old", "tokens": {"input": 99}})
        add("m1", "root", 1000, {"agent": "router", "model": {"id": "m-a"}, "tokens": {"input": 10, "output": 2, "reasoning": 1, "cache": {"read": 3, "write": 4}}, "content": [{"type": "tool", "name": "ok", "state": {"status": "completed"}}, {"type": "tool", "name": "aborted", "state": {"status": "error", "error": {"type": "aborted"}}}, {"type": "tool", "name": "stream", "state": {"status": "streaming"}}], "retry": 2})
        add("m2", "child", 1001, {"agent": "builder", "model": {"id": "m-b"}, "tokens": {"input": 5, "output": 6, "cache": {"write": 1}}, "content": [{"type": "tool", "name": "wait", "state": {"status": "running"}, "time": {"created": 900}}]})
        c.commit(); c.close()
        ownership = root / "ownership"; ownership.mkdir()
        intent = {"rootID": "root", "taskId": "task", "revision": 2, "intent": {"checks": [{"id": "build", "mode": "local"}]}}
        evidence = {"revision": 2, "lastStatus": "completed", "lastScope": "task", "checks": {"build": {"status": "passed", "mode": "local", "selfReported": True}}}
        (ownership / "one.json").write_text(json.dumps({"intents": {"key": intent}, "intentEvidence": {"key": evidence}}))
        return db, ownership

    def test_tree_cutoff_tokens_tools_and_acceptance(self):
        db, ownership = self.fixture()
        r = collect_metrics(db, session_id="root", days=7, now_ms=1000 + 7 * 86400000, ownership_dir=ownership)["reports"][0]
        self.assertEqual(r["sessions"], 2); self.assertEqual(r["tokens"]["uncached_input"], 15)
        self.assertEqual(r["tool_calls"]["succeeded"], 1); self.assertEqual(r["tool_calls"]["interrupted"], 1); self.assertEqual(r["tool_calls"]["outstanding"], 2)
        self.assertEqual(r["tool_retries"], 2); self.assertEqual(r["acceptance"][0]["status"], "self_reported_complete")
        self.assertEqual(r["outstanding_tools"][1]["duration_ms"], 1000 + 7 * 86400000 - 900)
        self.assertIsNone(r["blocked_minutes"]); self.assertNotIn("cost", json.dumps(r))

    def test_recent_child_keeps_stale_root_and_bad_evidence_unknown(self):
        db, ownership = self.fixture()
        r = collect_metrics(db, days=7, now_ms=1001 + 7 * 86400000, ownership_dir=ownership)["reports"]
        self.assertEqual(len(r), 1); self.assertEqual(r[0]["root_session"], "root")
        doc = json.loads((ownership / "one.json").read_text()); doc["intentEvidence"]["key"]["checks"]["extra"] = {"status": "passed", "mode": "local"}; (ownership / "one.json").write_text(json.dumps(doc))
        self.assertEqual(collect_metrics(db, session_id="root", now_ms=1001 + 7 * 86400000, ownership_dir=ownership)["reports"][0]["acceptance"][0]["status"], "unknown")


    def test_recent_grandchild_and_message_activity(self):
        db, ownership = self.fixture()
        with sqlite3.connect(db) as c:
            c.execute("update session_v2 set time_created=0,time_updated=0")
            c.execute("insert into session_v2 values ('grandchild','child',0,0)")
            c.execute("insert into session_message values ('new','grandchild','assistant',2,2000,?)", (json.dumps({"tokens":{"input":7}}),))
        reports=collect_metrics(db,days=1,now_ms=2000+86400000,ownership_dir=ownership)["reports"]
        self.assertEqual(len(reports),1)
        self.assertEqual(reports[0]["root_session"],"root")
        self.assertEqual(reports[0]["tokens"]["uncached_input"],7)

    def test_incomplete_stale_or_artifact_checks_never_claim_completion(self):
        db, ownership = self.fixture()
        original=json.loads((ownership/"one.json").read_text())
        cases=[("missing", lambda d:d["intents"]["key"]["intent"]["checks"].append({"id":"live","mode":"live"})),
               ("mode",lambda d:d["intentEvidence"]["key"]["checks"]["build"].update(mode="synthetic")),
               ("revision",lambda d:d["intentEvidence"]["key"].update(revision=1)),
               ("checkpoint",lambda d:d["intentEvidence"]["key"].update(lastScope="checkpoint")),
               ("blocked",lambda d:d["intentEvidence"]["key"].update(lastStatus="blocked")),
               ("artifact",lambda d:d["intents"]["key"]["intent"]["checks"][0].update(artifact="release"))]
        for name,change in cases:
            with self.subTest(name=name):
                d=json.loads(json.dumps(original));change(d)
                (ownership/"one.json").write_text(json.dumps(d))
                r=collect_metrics(db,session_id="root",now_ms=2000,ownership_dir=ownership)["reports"][0]
                self.assertEqual(r["acceptance"][0]["status"],"unknown")
                self.assertEqual(r["workload_label"],"per-root workload")

if __name__ == "__main__":
    unittest.main()

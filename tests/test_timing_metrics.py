import json
import tempfile
import unittest
from pathlib import Path

from src.timing_metrics import collect_timing


class TimingMetricsTest(unittest.TestCase):
    def write(self, rows):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        path = Path(tmp.name) / "execution-timing.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        return path

    def test_union_and_duplicate_intervals_do_not_add_parent_waits(self):
        path = self.write([
            {"event": "start", "category": "model_request", "interval_id": "p", "session_id": "root", "timestamp_ms": 10},
            {"event": "end", "category": "model_request", "interval_id": "p", "session_id": "root", "timestamp_ms": 30},
            {"event": "interval", "category": "model_request", "interval_id": "p", "session_id": "root", "start_ms": 10, "end_ms": 30},
            {"event": "interval", "category": "form_wait", "interval_id": "d", "session_id": "root", "start_ms": 20, "end_ms": 40},
        ])
        result = collect_timing(path, session_ids={"root"}, start_ms=0, end_ms=100)
        self.assertEqual(result["categories"]["model_request"]["duration_ms"], 20)
        self.assertEqual(result["overall"]["duration_ms"], 30)

    def test_open_and_unmatched_are_incomplete(self):
        path = self.write([
            {"event": "start", "category": "human_approval", "interval_id": "a", "timestamp_ms": 10},
            {"event": "end", "category": "human_approval", "interval_id": "missing", "timestamp_ms": 20},
        ])
        result = collect_timing(path, start_ms=0, end_ms=100)
        category = result["categories"]["human_approval"]
        self.assertEqual(category["status"], "incomplete")
        self.assertEqual(category["open"], 1)
        self.assertEqual(category["unmatched"], 1)
        self.assertIsNone(category["duration_ms"])

    def test_missing_file_uses_explicit_native_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            result = collect_timing(Path(directory) / "missing.jsonl", start_ms=0, end_ms=100,
                                    fallback_intervals=[{"category": "tool_shell_test", "interval_id": "t", "start_ms": 2, "end_ms": 8}])
        self.assertEqual(result["source"], "native_db_fallback")
        self.assertEqual(result["categories"]["native_tool"]["duration_ms"], 6)

    def test_empty_fallback_remains_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            result = collect_timing(Path(directory) / "missing.jsonl", fallback_intervals=[])
        self.assertEqual(result["source"], "unavailable")
        self.assertFalse(result["available"])

    def test_unavailable_without_fallback_is_unknown(self):
        with tempfile.TemporaryDirectory() as directory:
            result = collect_timing(Path(directory) / "missing.jsonl")
        self.assertFalse(result["available"])
        self.assertIsNone(result["overall"]["duration_ms"])
        self.assertIn("collection_unavailable", result["coverage"]["limitations"])

    def test_observer_schema_round_trip_and_diagnostics(self):
        path = self.write([
            {"schemaVersion": 1, "observedAt": 100, "event": "session.step.started", "phase": "model_request", "sessionId": "root", "messageId": "m1", "startedAt": 90},
            {"schemaVersion": 1, "observedAt": 120, "event": "session.step.streamed", "phase": "model_request", "sessionId": "root", "messageId": "m1", "startedAt": 90, "endedAt": 120, "durationMs": 30, "rateLimited": True, "droppedTelemetry": 2},
            {"schemaVersion": 1, "observedAt": 110, "event": "session.tool.input.started", "phase": "native_tool", "sessionId": "root", "messageId": "m1", "toolId": "t1", "startedAt": 110},
            {"schemaVersion": 1, "observedAt": 140, "event": "session.tool.success", "phase": "native_tool", "sessionId": "root", "messageId": "m1", "toolId": "t1", "startedAt": 110, "endedAt": 140},
            {"schemaVersion": 1, "observedAt": 130, "event": "permission.asked", "phase": "permission", "sessionId": "root", "requestId": "p1", "startedAt": 130},
            {"schemaVersion": 1, "observedAt": 150, "event": "permission.replied", "phase": "permission", "sessionId": "root", "requestId": "p1", "startedAt": 130, "endedAt": 150},
        ])
        result = collect_timing(path, session_ids={"root"}, start_ms=0, end_ms=200)
        self.assertEqual(result["categories"]["model_request"]["duration_ms"], 30)
        self.assertEqual(result["categories"]["model_request"]["open"], 0)
        self.assertEqual(result["categories"]["native_tool"]["duration_ms"], 30)
        self.assertEqual(result["categories"]["human_approval"]["duration_ms"], 20)
        self.assertEqual(result["diagnostics"], {"droppedTelemetry": 2, "rateLimited": 1, "serviceWideLoss": 2})

    def test_observer_starts_use_observed_at_and_scope_reused_ids(self):
        path = self.write([
            {"observedAt": 1, "event": "form.created", "phase": "form", "sessionId": "a", "formId": "same"},
            {"observedAt": 4, "event": "form.replied", "phase": "form", "sessionId": "a", "formId": "same"},
            {"observedAt": 10, "event": "permission.asked", "phase": "permission", "sessionId": "b", "requestId": "same"},
            {"observedAt": 14, "event": "permission.replied", "phase": "permission", "sessionId": "b", "requestId": "same"},
            {"observedAt": 1, "event": "session.step.failed", "phase": "model_request", "sessionId": "old", "messageId": "m", "rateLimited": True},
        ])
        result = collect_timing(path, session_ids={"a", "b"}, start_ms=2, end_ms=20)
        self.assertEqual(result["categories"]["form_wait"]["duration_ms"], 2)
        self.assertEqual(result["categories"]["human_approval"]["duration_ms"], 4)
        self.assertEqual(result["diagnostics"]["rateLimited"], 0)

    def test_root_diagnostics_deduplicate_and_native_history_survives_new_collection(self):
        current = {"eventId":"same", "observedAt":80,"event":"session.step.failed", "phase":"model_request", "sessionId":"root", "messageId":"m", "rateLimited":True}
        path = self.write([current, current, {**current, "eventId":"other", "sessionId":"other"}])
        result = collect_timing(path, session_ids={"root"}, start_ms=0, end_ms=100,
            fallback_intervals=[{"category":"native_tool", "session_id":"root", "interval_id":str(i), "start_ms":a, "end_ms":b}
                for i,a,b in [(1,1,5),(2,6,10)]])
        self.assertEqual(result["diagnostics"]["rateLimited"], 1)
        self.assertEqual(result["categories"]["native_tool"]["duration_ms"], 8)
        self.assertEqual(result["source"], "telemetry_and_native_db")

    def test_stream_and_database_native_call_are_one_interval(self):
        path = self.write([{"phase":"native_tool", "event":"session.tool.success", "sessionId":"root", "messageId":"m", "toolId":"t", "startedAt":10, "endedAt":30}])
        result = collect_timing(path, session_ids={"root"}, fallback_intervals=[
            {"category":"native_tool", "session_id":"root", "messageId":"m", "toolId":"t", "start_ms":10, "end_ms":30}])
        self.assertEqual(result["categories"]["native_tool"]["intervals"],1)
        self.assertEqual(result["overall"]["duration_ms"],20)


if __name__ == "__main__":
    unittest.main()

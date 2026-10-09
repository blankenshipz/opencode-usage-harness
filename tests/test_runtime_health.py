import json
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
import runtime_health


class RuntimeHealthTest(unittest.TestCase):
    def db(self):
        handle = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        handle.close()
        self.addCleanup(lambda: Path(handle.name).unlink(missing_ok=True))
        db = sqlite3.connect(handle.name)
        db.execute("create table session_v2 (id text primary key, parent_id text, time_suspended integer)")
        db.executemany("insert into session_v2 values (?,?,?)", [("root", None, None), ("child", "root", 1), ("other", None, 1)])
        db.commit(); db.close()
        return handle.name

    def test_active_and_claim_without_owner(self):
        db = self.db()
        with mock.patch.dict(os.environ, {"OPENCODE_SERVER_URL": "http://127.0.0.1:4096", "OPENCODE_SERVER_PASSWORD": "secret"}):
            with mock.patch.object(runtime_health, "_native_active", return_value=True):
                self.assertEqual(runtime_health.inspect("child", caller_id="root", db_path=db)["assessment"], "active")
            with mock.patch.object(runtime_health, "_native_active", return_value=False):
                self.assertEqual(runtime_health.inspect("child", caller_id="root", db_path=db)["assessment"], "claim_without_owner")

    def test_unavailable_native_is_unknown(self):
        db = self.db()
        with mock.patch.dict(os.environ, {"OPENCODE_SERVER_URL": "http://127.0.0.1:4096", "OPENCODE_SERVER_PASSWORD": "secret"}), mock.patch.object(runtime_health, "_native_active", return_value=None):
            result = runtime_health.inspect("child", caller_id="root", db_path=db)
        self.assertEqual(result["assessment"], "unknown")

    def test_malformed_native_payload_is_unknown_not_idle(self):
        for payload in ({}, {"data": []}, {"data": {"root": "running"}}):
            response = mock.MagicMock()
            response.headers = {}
            response.read.return_value = json.dumps(payload).encode()
            response.__enter__.return_value = response
            opener = mock.MagicMock()
            opener.open.return_value = response
            with mock.patch.object(runtime_health.urllib.request, "build_opener", return_value=opener):
                self.assertIsNone(runtime_health._native_active("http://127.0.0.1:4096", "secret", "root"))

    def test_missing_database_configuration_is_unknown(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            result = runtime_health.inspect("root", caller_id="root")
        self.assertEqual(result["assessment"], "unknown")

    def test_caller_ancestry_denies_unrelated_session(self):
        db = self.db()
        result = runtime_health.inspect("other", caller_id="root", db_path=db)
        self.assertEqual(result["assessment"], "unknown")
        self.assertEqual(result["warning"], "caller is not session owner or ancestor")

    def test_external_url_rejected_without_request(self):
        with self.assertRaises(ValueError):
            runtime_health._validate_url("https://example.com")
        with self.assertRaises(ValueError):
            runtime_health._validate_url("http://localhost:4096")


if __name__ == "__main__":
    unittest.main()

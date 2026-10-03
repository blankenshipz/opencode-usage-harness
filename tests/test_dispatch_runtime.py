import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.dispatch_runtime import intent_sources, sessions
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

    def test_defaults_are_state_dir_and_database_is_required(self):
        with patch.dict(os.environ, {"HARNESS_STATE_DIR": "/tmp/harness-state"}, clear=True):
            self.assertEqual(state_dir(), Path("/tmp/harness-state"))
            self.assertEqual(quota_cache_path(), Path("/tmp/harness-state/quota/cache.json"))
            self.assertEqual(ownership_dir(), Path("/tmp/harness-state/dispatch-ownership"))
            with self.assertRaisesRegex(RuntimeError, "HARNESS_OPENCODE_DB"):
                opencode_db()


if __name__ == "__main__":
    unittest.main()

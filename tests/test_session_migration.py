import importlib.util
import json
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("session_migration", ROOT / "src" / "session_migration.py")
assert SPEC is not None and SPEC.loader is not None
MIGRATION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIGRATION)


class FakeTransport:
    def __init__(self, historical=None, canonical=None, active=None):
        self.historical = historical or {"id": "old", "directory": "/work", "metadata": {"keep": "value"}}
        self.canonical = canonical or {"id": "new", "directory": "/work", "metadata": {}}
        self.active = [] if active is None else active
        self.calls = []

    def request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if method == "GET" and path == "/session/old":
            return self.historical
        if method == "GET" and path == "/session/new":
            return self.canonical
        if method == "GET" and path == "/session/active":
            return self.active
        if method == "PATCH" and path == "/session/old":
            return {"ok": True}
        raise AssertionError((method, path))


class TargetShapeTransport(FakeTransport):
    """Mock the current OpenCode HTTP envelope after HttpTransport unwraps it."""
    def request(self, method, path, body=None):
        response = super().request(method, path, body)
        if method == "GET" and path == "/session/old":
            return MIGRATION.unwrap_api_data({"data": {
                "id": "old", "location": {"directory": "/project"}, "metadata": {"keep": "value"},
            }})
        if method == "GET" and path == "/session/new":
            return MIGRATION.unwrap_api_data({"data": {
                "id": "new", "location": {"directory": "/project"}, "metadata": {},
            }})
        if method == "GET" and path == "/session/active":
            return MIGRATION.unwrap_api_data({"data": {}})
        return response


class ChangingMetadataTransport(FakeTransport):
    def __init__(self):
        super().__init__()
        self.historical_reads = 0

    def request(self, method, path, body=None):
        if method == "GET" and path == "/session/old":
            self.historical_reads += 1
            if self.historical_reads == 2:
                self.historical = {"id": "old", "directory": "/work", "metadata": {"keep": "changed"}}
        return super().request(method, path, body)


class FakeHttpResponse:
    status = 200

    def __init__(self, payload):
        self.payload = payload

    def read(self):
        return json.dumps(self.payload).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class FakeOpener:
    def __init__(self, payload):
        self.payload = payload
        self.request = None

    def open(self, request, timeout):
        self.request = request
        return FakeHttpResponse(self.payload)


class SessionMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.state = Path(self.temp.name) / "state"

    def tearDown(self):
        self.temp.cleanup()

    def test_dry_run_gets_and_validates_without_patch_or_backup(self):
        transport = FakeTransport()
        result = MIGRATION.migrate(transport, "old", "new", apply=False, state_dir=self.state)
        self.assertFalse(result["applied"])
        self.assertEqual(result["inactivity_check"], "snapshot_only")
        self.assertEqual([call[:2] for call in transport.calls], [
            ("GET", "/session/old"), ("GET", "/session/new"), ("GET", "/session/active"),
        ])
        self.assertFalse(self.state.exists())

    def test_apply_preserves_metadata_and_writes_private_snapshot(self):
        transport = FakeTransport()
        result = MIGRATION.migrate(transport, "old", "new", apply=True, state_dir=self.state)
        self.assertTrue(result["applied"])
        self.assertEqual(result["inactivity_check"], "snapshot_only")
        self.assertEqual([call[:2] for call in transport.calls], [
            ("GET", "/session/old"), ("GET", "/session/new"), ("GET", "/session/active"),
            ("GET", "/session/old"), ("GET", "/session/active"), ("PATCH", "/session/old"),
        ])
        patch = transport.calls[-1]
        self.assertEqual(patch[:2], ("PATCH", "/session/old"))
        self.assertEqual(patch[2]["metadata"], {
            "keep": "value",
            "harnessMigration": {"canonicalSessionID": "new", "historical": True},
        })
        backups = list((self.state / "session-migration-backups").glob("*.json"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(stat.S_IMODE(backups[0].stat().st_mode), 0o600)
        self.assertEqual(json.loads(backups[0].read_text())["metadata"], {"keep": "value"})

    def test_apply_rejects_concurrent_metadata_change_before_patch(self):
        transport = ChangingMetadataTransport()
        with self.assertRaisesRegex(MIGRATION.MigrationError, "metadata changed"):
            MIGRATION.migrate(transport, "old", "new", apply=True, state_dir=self.state)
        self.assertEqual(transport.historical_reads, 2)
        self.assertFalse(any(call[0] == "PATCH" for call in transport.calls))
        self.assertFalse(self.state.exists())

    def test_current_opencode_target_envelopes_work_end_to_end(self):
        transport = TargetShapeTransport()
        result = MIGRATION.migrate(transport, "old", "new", apply=True, state_dir=self.state)
        self.assertTrue(result["applied"])
        self.assertEqual(transport.calls[-1][2]["metadata"]["harnessMigration"]["canonicalSessionID"], "new")
        self.assertEqual(MIGRATION.active_ids({"old": {"type": "running"}}), {"old"})

    def test_http_transport_unwraps_target_envelope(self):
        transport = MIGRATION.HttpTransport("http://127.0.0.1:4096", "/api", "Bearer token")
        opener = FakeOpener({"data": {"id": "old", "location": {"directory": "/project"}, "metadata": {}}})
        transport.opener = opener
        session = transport.request("GET", "/session/old")
        self.assertEqual(session["location"]["directory"], "/project")
        self.assertEqual(opener.request.full_url, "http://127.0.0.1:4096/api/session/old")

    def test_rejects_active_historical_and_does_not_patch(self):
        transport = FakeTransport(active=[{"id": "old"}])
        with self.assertRaisesRegex(MIGRATION.MigrationError, "active execution"):
            MIGRATION.migrate(transport, "old", "new", apply=True, state_dir=self.state)
        self.assertFalse(any(call[0] == "PATCH" for call in transport.calls))

    def test_rejects_different_directories_and_canonical_cycle(self):
        transport = FakeTransport(canonical={"id": "new", "directory": "/other", "metadata": {}})
        with self.assertRaisesRegex(MIGRATION.MigrationError, "same directory"):
            MIGRATION.migrate(transport, "old", "new", apply=False, state_dir=self.state)
        transport = FakeTransport(canonical={"id": "new", "directory": "/work", "metadata": {"harnessMigration": {"historical": True}}})
        with self.assertRaisesRegex(MIGRATION.MigrationError, "itself historical"):
            MIGRATION.migrate(transport, "old", "new", apply=False, state_dir=self.state)

    def test_rejects_bad_ids_and_non_loopback_server(self):
        with self.assertRaises(MIGRATION.MigrationError):
            MIGRATION.validate_id("../old", "--historical")
        with self.assertRaises(MIGRATION.MigrationError):
            MIGRATION.validate_server("https://example.com")
        with self.assertRaises(MIGRATION.MigrationError):
            MIGRATION.validate_server("http://user:password@127.0.0.1:4096?token=secret")
        self.assertEqual(MIGRATION.validate_server("http://localhost:4096"), "http://localhost:4096")
        transport = MIGRATION.HttpTransport("http://127.0.0.1:4096", "http://localhost:4097/api", "Bearer token")
        self.assertEqual(transport.base, "http://localhost:4097/api")


if __name__ == "__main__":
    unittest.main()

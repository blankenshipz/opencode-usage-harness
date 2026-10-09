import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "bin" / "harness-check"
sys.path.insert(0, str(ROOT / "src"))
import check_receipt


class CheckReceiptTest(unittest.TestCase):
    def invoke(self, *args, env=None, state_dir=None):
        state = state_dir or tempfile.TemporaryDirectory()
        if not state_dir:
            self.addCleanup(state.cleanup)
        run_env = os.environ.copy()
        run_env["HARNESS_STATE_DIR"] = state if isinstance(state, str) else state.name
        if env:
            run_env.update(env)
        result = subprocess.run([str(BIN), *args], env=run_env, text=True, capture_output=True)
        line = result.stdout.strip().splitlines()[-1]
        receipt_path = Path(line.split(": ", 1)[1])
        return result, receipt_path

    def test_success_and_failure_persist_private_logs(self):
        result, path = self.invoke("--label", "unit-run", "--", sys.executable, "-c", "print('out'); print('err', file=__import__('sys').stderr)")
        self.assertEqual(result.returncode, 0)
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt["outcome"], "succeeded")
        self.assertEqual((path.parent / receipt["stdout_file"]).read_text(), "out\n")
        self.assertEqual((path.parent / receipt["stderr_file"]).read_text(), "err\n")
        self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((path.parent / receipt["stdout_file"]).stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((path.parent / receipt["stderr_file"]).stat().st_mode), 0o600)
        result, path = self.invoke("--label", "failed", "--revision", "rev-1", "--", sys.executable, "-c", "raise SystemExit(7)")
        self.assertEqual(result.returncode, 7)
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt["exit_code"], 7)
        self.assertEqual(receipt["revision"], "rev-1")

    def test_runs_are_unique_and_receipt_has_no_command_or_environment(self):
        state = tempfile.mkdtemp()
        first, p1 = self.invoke("--label", "same", "--", sys.executable, "-c", "pass", state_dir=state)
        second, p2 = self.invoke("--label", "same", "--", sys.executable, "-c", "pass", state_dir=state)
        self.assertEqual(first.returncode, second.returncode, 0)
        self.assertNotEqual(p1.parent, p2.parent)
        text = p1.read_text()
        self.assertNotIn(sys.executable, text)
        self.assertNotIn("HARNESS_STATE_DIR", text)
        self.assertNotIn("command", json.loads(text))

    def test_interrupt_retains_receipt_and_normalizes_signal_exit(self):
        state = tempfile.mkdtemp()
        env = os.environ.copy()
        env["HARNESS_STATE_DIR"] = state
        process = subprocess.Popen(
            [str(BIN), "--label", "interrupt", "--", sys.executable, "-c", "import time; time.sleep(30)"],
            env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        line = process.stdout.readline()
        process.send_signal(signal.SIGTERM)
        stdout, _ = process.communicate(timeout=5)
        path = Path(line.strip().split(": ", 1)[1])
        receipt = json.loads(path.read_text())
        self.assertEqual(process.returncode, 143)
        self.assertEqual(receipt["outcome"], "interrupted")
        self.assertEqual(receipt["exit_code"], 143)
        self.assertEqual(receipt["child_returncode"], -15)

    def test_revision_rejects_blank_and_control_character(self):
        for revision in ("   ", "bad\nrevision"):
            result = subprocess.run([str(BIN), "--label", "revision", "--revision", revision, "--", "true"], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_missing_executable_is_startup_error_127(self):
        result, path = self.invoke("--label", "missing", "--", "definitely-missing-harness-command")
        self.assertEqual(result.returncode, 127)
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt["outcome"], "startup_error")
        self.assertEqual(receipt["startup_error"], "FileNotFoundError")

    def test_capacity_preflight_blocks_without_launching_command(self):
        state = tempfile.mkdtemp()
        marker = Path(state) / "launched"
        result, path = self.invoke(
            "--label", "capacity", "--reserve-bytes", str(10**30), "--",
            sys.executable, "-c", f"__import__('pathlib').Path({str(marker)!r}).touch()",
            state_dir=state,
        )
        self.assertEqual(result.returncode, 125)
        self.assertFalse(marker.exists())
        receipt = json.loads(path.read_text())
        self.assertEqual(receipt["outcome"], "capacity_blocked")
        self.assertEqual({item["path"] for item in receipt["capacity"]["checks"]}, {str(Path.cwd()), str(Path(state) / "check-receipts")})

    def test_capacity_checks_cwd_and_receipt_filesystem_separately(self):
        state = tempfile.mkdtemp()
        checked = []
        original = check_receipt._capacity

        def record(path, reserve):
            checked.append(path)
            return original(path, reserve)

        with mock.patch.dict(os.environ, {"HARNESS_STATE_DIR": state}), mock.patch.object(check_receipt, "_capacity", side_effect=record):
            self.assertEqual(check_receipt.run("distinct", None, [sys.executable, "-c", "pass"], 0), 0)
        self.assertEqual(checked, [Path.cwd(), Path(state) / "check-receipts"])

    def test_status_identity_mismatch_and_legacy_receipt_are_safe(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "receipt.json"
            path.write_text(json.dumps({
                "receipt_version": 2, "outcome": "running", "finished_at": None,
                "process_pid": os.getpid(), "process_identity": "wrong-birth",
            }))
            result = subprocess.run([str(BIN), "--status", str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0)
            with mock.patch.object(check_receipt, "_process_identity", return_value="different-birth"):
                self.assertEqual(check_receipt.inspect_receipt(path)["status"], "owner_missing")
            path.write_text(json.dumps({"outcome": "running", "process_pid": os.getpid()}))
            result = subprocess.run([str(BIN), "--status", str(path)], text=True, capture_output=True)
            self.assertEqual(json.loads(result.stdout)["status"], "unknown")

    def test_missing_owner_without_identity_and_imprecise_platform(self):
        document = {"receipt_version": 2, "outcome": "running", "process_pid": 123, "process_identity": None}
        with mock.patch.object(check_receipt.os, "kill", side_effect=ProcessLookupError):
            self.assertEqual(check_receipt._health(document), "owner_missing")
        with mock.patch.object(check_receipt.Path, "exists", return_value=False):
            self.assertIsNone(check_receipt._process_identity(123))

    def test_status_is_unknown_when_birth_identity_cannot_be_verified(self):
        document = {
            "receipt_version": 2, "outcome": "running", "finished_at": None,
            "process_pid": os.getpid(), "process_identity": "recorded",
        }
        with mock.patch.object(check_receipt, "_process_identity", return_value=None):
            self.assertEqual(check_receipt._health(document), "unknown")

    def test_unavailable_capacity_blocks_with_explicit_receipt(self):
        state = tempfile.mkdtemp()
        with mock.patch.dict(os.environ, {"HARNESS_STATE_DIR": state}), mock.patch.object(
            check_receipt, "_capacity", return_value={"path": "x", "status": "unavailable", "available_bytes": None}
        ):
            self.assertEqual(check_receipt.run("unavailable", None, [sys.executable, "-c", "raise SystemExit(3)"], 0), 125)
        receipts = list((Path(state) / "check-receipts").glob("*/receipt.json"))
        self.assertEqual(len(receipts), 1)
        receipt = json.loads(receipts[0].read_text())
        self.assertEqual(receipt["outcome"], "capacity_unavailable")


if __name__ == "__main__":
    unittest.main()

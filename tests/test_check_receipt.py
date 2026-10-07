import json
import os
import signal
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / "bin" / "harness-check"


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


if __name__ == "__main__":
    unittest.main()

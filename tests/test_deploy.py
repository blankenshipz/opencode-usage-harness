import argparse
import contextlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("harness_installer_deploy", ROOT / "install.py")
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)


def args(**overrides):
    base = dict(release="0.4.0", wait=0, restart=False, dry_run=False, force=False, project=None, root=None,
                env_file=None, bridge=None, gateway_dir=None, opencode_db=None, backup_dir=None,
                resume_command="", skip_validate=True)
    base.update(overrides)
    return argparse.Namespace(**base)


class FakeRunner:
    def __init__(self, release="0.4.0", resume_available=False):
        self.calls, self.release, self.resume_available = [], release, resume_available

    def __call__(self, argv, cwd=None, timeout=60):
        self.calls.append(list(argv))
        if "/api/plugin" in argv:
            return 0, '{"id":"x","path":"/p/releases/%s/plugins"}' % self.release
        if "--help" in argv:
            return (0 if self.resume_available else 2), ""
        return 0, ""


class DeployTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.prefix = self.root / "harness"
        for name in ("0.3.9", "0.4.0"):
            (self.prefix / "releases" / name / "plugins/v2").mkdir(parents=True)
        os.symlink(self.prefix / "releases/0.3.9", self.prefix / "current")
        (self.root / "state/config").mkdir(parents=True)
        (self.root / "state/config/opencode.json").write_text('{"secret":"do-not-print"}')
        self.bridge = self.root / "workrelay-bridge.json"
        self.bridge.write_text(json.dumps({"guard_entry": "old", "other": 1}))
        os.chmod(self.bridge, 0o600)
        self.project = str(self.root / "proj")
        os.mkdir(self.project)

    def tearDown(self):
        self.temp.cleanup()

    def run_deploy(self, probe, **kw):
        out, err = io.StringIO(), io.StringIO()
        runner = kw.pop("runner", FakeRunner())
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project], **kw), probe=probe, runner=runner,
                                  sleep=lambda s: None)
        return code, out.getvalue(), err.getvalue(), runner

    def test_refuses_when_busy_with_exit_3(self):
        code, out, err, _ = self.run_deploy(lambda: {"pending": {self.project: 2}, "busy": 1})
        self.assertEqual(code, 3)
        self.assertIn("2 pending permission ask(s)", err)
        self.assertIn("1 busy session(s)", err)
        self.assertEqual(os.readlink(self.prefix / "current"), str(self.prefix / "releases/0.3.9"))
        self.assertEqual(json.loads(self.bridge.read_text())["guard_entry"], "old")

    def test_wait_polls_until_idle(self):
        states = iter([{"pending": {}, "busy": 1}, {"pending": {}, "busy": 1}, {"pending": {}, "busy": 0}])
        ticks = iter(range(100))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project], wait=60), probe=lambda: next(states),
                                  runner=FakeRunner(), sleep=lambda s: None, clock=lambda: next(ticks))
        self.assertEqual(code, 0, err.getvalue())
        self.assertIn("waiting", out.getvalue())

    def test_wait_gives_up(self):
        ticks = iter(range(0, 1000, 30))
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project], wait=60), probe=lambda: {"busy": 2},
                                  runner=FakeRunner(), sleep=lambda s: None, clock=lambda: next(ticks))
        self.assertEqual(code, 3)

    def test_idle_deploy_switches_links_backs_up_and_updates_bridge(self):
        code, out, err, runner = self.run_deploy(lambda: {"pending": {self.project: 0}, "busy": 0})
        self.assertEqual(code, 0, err)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.4.0")
        self.assertEqual(Path(os.readlink(self.prefix / "previous")).name, "0.3.9")
        bridge = json.loads(self.bridge.read_text())
        self.assertTrue(bridge["guard_entry"].endswith("releases/0.4.0/plugins/v2/subscription-guard/index.mjs"))
        self.assertEqual(bridge["other"], 1)
        self.assertEqual(self.bridge.stat().st_mode & 0o777, 0o600)
        backups = list((self.root / "backups").iterdir())
        self.assertEqual(len(backups), 1)
        self.assertTrue((backups[0] / "opencode.json").is_file())
        self.assertEqual((backups[0] / "harness-current.txt").read_text().strip(), "0.3.9")
        self.assertNotIn("do-not-print", out + err)
        self.assertFalse(any(c[-3:] == ["service", "stop"] or c[-2:] == ["service", "stop"] for c in runner.calls))
        self.assertIn("resume hook disabled", out)

    def test_not_loaded_exit_4(self):
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, runner=FakeRunner(release="other"))
        self.assertEqual(code, 4)
        self.assertIn("not loaded", err)

    def test_restart_and_resume_hook(self):
        runner = FakeRunner(resume_available=True)
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, restart=True, runner=runner, resume_command="wr resume")
        self.assertEqual(code, 0, err)
        flat = [" ".join(c) for c in runner.calls]
        self.assertTrue(any(c.endswith("opencode service stop") for c in flat))
        self.assertTrue(any(c.endswith("opencode service start") for c in flat))
        self.assertTrue(any(c.endswith("wr resume") for c in flat))
        self.assertIn("resume hook exit 0", out)

    def test_resume_hook_absent_is_skipped(self):
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, resume_command="wr resume")
        self.assertEqual(code, 0, err)
        self.assertIn("resume hook unavailable, skipped", out)

    def test_dry_run_changes_nothing(self):
        code, out, err, _ = self.run_deploy(lambda: self.fail("probe must not run"), dry_run=True, restart=True)
        self.assertEqual(code, 0)
        self.assertIn("opencode service stop", out)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")

    def test_missing_release(self):
        with self.assertRaises(INSTALL.InstallError):
            INSTALL.deploy(self.prefix, args(release="9.9.9"), probe=lambda: {})

    def test_cli_dispatch_refuses_busy_via_force_false(self):
        parsed = INSTALL.parser().parse_args(["--prefix", str(self.prefix), "deploy", "0.4.0", "--wait", "5", "--restart", "--dry-run"])
        self.assertEqual((parsed.release, parsed.wait, parsed.restart, parsed.dry_run), ("0.4.0", 5.0, True, True))


@unittest.skipUnless(shutil.which("git"), "git required")
class CommitHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name) / "repo"
        self.repo.mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Owner")
        self.git("config", "user.email", "owner@example.invalid")

    def tearDown(self):
        self.temp.cleanup()

    def git(self, *a, env=None):
        full = {k: v for k, v in os.environ.items() if k not in {"HARNESS_AGENT", "HARNESS_ROLE", "WORKRELAY_SESSION_ID"} and not k.startswith("GIT_")}
        full.update(env or {})
        return subprocess.run(["git", "-C", str(self.repo), *a], capture_output=True, text=True, check=True, env=full).stdout

    def commit(self, message, env=None):
        (self.repo / "f").write_text(message)
        self.git("add", "f")
        self.git("commit", "-q", "-m", message, env=env)
        return self.git("log", "-1", "--format=%B%n--%an <%ae>|%cn <%ce>")

    def test_script_matches_installer_payload(self):
        self.assertEqual((ROOT / "scripts/git-hooks/prepare-commit-msg").read_text(), INSTALL.PREPARE_COMMIT_MSG)

    def test_trailers_added_and_identity_kept(self):
        INSTALL.install_commit_hook(self.repo)
        log = self.commit("work", {"HARNESS_AGENT": "builder-1", "HARNESS_ROLE": "builder", "WORKRELAY_SESSION_ID": "ses_123"})
        self.assertIn("Agent: builder-1\nHarness-Role: builder\nWorkrelay-Session: ses_123", log)
        self.assertIn("--Owner <owner@example.invalid>|Owner <owner@example.invalid>", log)

    def test_unset_skipped_and_no_duplicates(self):
        INSTALL.install_commit_hook(self.repo)
        log = self.commit("plain")
        self.assertNotIn("Agent:", log)
        log = self.commit("x\n\nAgent: manual", {"HARNESS_AGENT": "builder-1", "HARNESS_ROLE": "reviewer"})
        self.assertEqual(log.count("Agent:"), 1)
        self.assertIn("Agent: manual", log)
        self.assertIn("Harness-Role: reviewer", log)
        self.assertNotIn("Workrelay-Session", log)

    def test_existing_hook_is_chained(self):
        hooks = self.repo / ".git/hooks"
        hooks.mkdir(exist_ok=True)
        old = hooks / "prepare-commit-msg"
        old.write_text('#!/bin/sh\necho "Chained-By: old" >> "$1"\n')
        os.chmod(old, 0o755)
        self.assertIn("chained", INSTALL.install_commit_hook(self.repo))
        self.assertIn("already installed", INSTALL.install_commit_hook(self.repo))
        log = self.commit("c", {"HARNESS_AGENT": "a1"})
        self.assertIn("Chained-By: old", log)
        self.assertIn("Agent: a1", log)


if __name__ == "__main__":
    unittest.main()

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
    """`plugin_down` scripts the first /api/plugin replies while the service starts (e.g. [(1, ""), (0, "<html>")]);
    `never_up=True` keeps it down for good; `stale_reports` answers JSON without the release path that many times
    (an int counts across all projects, a dict {project: n} counts per project)."""
    def __init__(self, release="0.4.0", resume_available=False, fail_on=None, plugin_down=(), never_up=False, stale_reports=0):
        self.calls, self.release, self.resume_available, self.fail_on = [], release, resume_available, fail_on
        self.plugin_down, self.never_up, self.stale_reports = list(plugin_down), never_up, stale_reports
        self.plugin_calls = 0

    def __call__(self, argv, cwd=None, timeout=60):
        self.calls.append(list(argv))
        if self.fail_on and self.fail_on in " ".join(argv):
            return 1, ""
        if "/api/plugin" in argv:
            self.plugin_calls += 1
            if self.never_up:
                return 1, "connection refused"
            if self.plugin_down:
                return self.plugin_down.pop(0)
            stale = self.stale_reports.get(cwd, 0) if isinstance(self.stale_reports, dict) else self.stale_reports
            if stale:  # up, but still reporting the previous release's plugins
                if isinstance(self.stale_reports, dict):
                    self.stale_reports[cwd] -= 1
                else:
                    self.stale_reports -= 1
                return 0, '{"id":"x","path":"/p/releases/0.3.9/plugins"}'
            return 0, '{"id":"x","path":"/p/releases/%s/plugins"}' % self.release
        if "--help" in argv:
            return (0 if self.resume_available else 2), ""
        return 0, ""


class FakeClock:
    """Monotonic clock that only advances when the code under test sleeps."""
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


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
        clock = kw.pop("clock", FakeClock())
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project], **kw), probe=probe, runner=runner,
                                  sleep=clock.sleep, clock=clock)
        return code, out.getvalue(), err.getvalue(), runner

    def test_refuses_when_busy_with_exit_3(self):
        code, out, err, _ = self.run_deploy(lambda: {"pending": {self.project: 2}, "busy": 1})
        self.assertEqual(code, 3)
        self.assertIn("2 pending permission ask(s)", err)
        self.assertIn("1 busy session(s)", err)
        self.assertEqual(os.readlink(self.prefix / "current"), str(self.prefix / "releases/0.3.9"))
        self.assertEqual(json.loads(self.bridge.read_text())["guard_entry"], "old")

    def test_wait_polls_until_idle(self):
        states = iter([{"pending": {}, "busy": 1}, {"pending": {}, "busy": 1}, {"pending": {}, "busy": 0}, {"busy": 0}])
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
        clock = FakeClock()
        code, out, err, runner = self.run_deploy(lambda: {"busy": 0}, runner=FakeRunner(release="other"), clock=clock)
        self.assertEqual(code, 4)
        self.assertIn("not loaded", err)
        # The service answered, but never with the release path: polled until the deadline, then exit 4.
        self.assertGreaterEqual(clock.now, INSTALL.WARM_WAIT_SECONDS)
        self.assertGreater(runner.plugin_calls, 2)

    def test_warm_check_waits_for_service_after_restart(self):
        # 0.4.1 deploy: the first /api/plugin calls after the restart failed or were not JSON.
        clock = FakeClock()
        runner = FakeRunner(plugin_down=[(1, ""), (0, ""), (0, "<html>starting</html>"), (7, "connection refused")])
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, restart=True, runner=runner, clock=clock)
        self.assertEqual(code, 0, err)
        self.assertNotIn("not loaded", err)
        self.assertIn("waiting up to", out)
        self.assertIn("1 plugin(s) from 0.4.0", out)
        self.assertEqual(runner.plugin_calls, 6)  # 4 down, 1 that loads plugins, 1 that reports them
        self.assertEqual(clock.sleeps[-4:], [INSTALL.WARM_POLL_SECONDS] * 4)  # one poll interval per failed call

    def test_warm_check_retries_until_release_is_reported(self):
        clock = FakeClock()
        runner = FakeRunner(stale_reports=3)
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, runner=runner, clock=clock)
        self.assertEqual(code, 0, err)
        self.assertEqual(runner.plugin_calls, 4)
        self.assertNotIn("waiting up to", out)  # the service was up; only the plugin report lagged

    def test_warm_check_exit_4_when_service_never_comes_up(self):
        clock = FakeClock()
        runner = FakeRunner(never_up=True)
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, runner=runner, clock=clock)
        self.assertEqual(code, 4)
        self.assertIn("not loaded", err)
        self.assertGreaterEqual(clock.now, INSTALL.WARM_WAIT_SECONDS)
        self.assertLess(clock.now, INSTALL.WARM_WAIT_SECONDS + INSTALL.WARM_POLL_SECONDS + 1)
        self.assertTrue(all(s <= INSTALL.WARM_POLL_SECONDS for s in clock.sleeps))

    def test_warm_check_deadline_is_shared_across_projects(self):
        other = str(self.root / "proj2")
        os.mkdir(other)
        clock = FakeClock()
        runner = FakeRunner(never_up=True)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project, other]), probe=lambda: {"busy": 0},
                                  runner=runner, sleep=clock.sleep, clock=clock)
        self.assertEqual(code, 4)
        self.assertIn(other, err.getvalue())
        self.assertLess(clock.now, INSTALL.WARM_WAIT_SECONDS + INSTALL.WARM_POLL_SECONDS + 1)
        self.assertNotIn("waiting up to 0s", out.getvalue())
        self.assertIn("no wait budget left", out.getvalue())

    def test_warm_check_late_service_still_gives_later_projects_a_report_budget(self):
        # Fable M1: the service answers only ~58 s into the 60 s window; a later project still needs
        # a couple of stale plugin reports.  It must get its own report budget, not just the shared leftover.
        projects = [self.project]
        for name in ("proj2", "proj3"):
            projects.append(str(self.root / name))
            os.mkdir(projects[-1])
        clock = FakeClock()
        down = int(INSTALL.WARM_WAIT_SECONDS / INSTALL.WARM_POLL_SECONDS) - 1  # up at t=58 with 2 s polls
        runner = FakeRunner(plugin_down=[(1, "")] * down, stale_reports={projects[1]: 3, projects[2]: 2})
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=projects), probe=lambda: {"busy": 0},
                                  runner=runner, sleep=clock.sleep, clock=clock)
        self.assertEqual(code, 0, err.getvalue())
        for project in projects:
            self.assertIn("%s: 1 plugin(s) from 0.4.0" % project, out.getvalue())
        self.assertGreater(clock.now, INSTALL.WARM_WAIT_SECONDS)  # past the shared window, on the report budget
        self.assertLess(clock.now, INSTALL.WARM_WAIT_SECONDS + 3 * INSTALL.WARM_REPORT_SECONDS)

    def test_warm_check_report_budget_is_bounded_after_late_start(self):
        # Service up at t=58 but the release never shows: exit 4 after the per-project report budget, no hang.
        other = str(self.root / "proj2")
        os.mkdir(other)
        clock = FakeClock()
        down = int(INSTALL.WARM_WAIT_SECONDS / INSTALL.WARM_POLL_SECONDS) - 1
        runner = FakeRunner(release="other", plugin_down=[(1, "")] * down)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(project=[self.project, other]), probe=lambda: {"busy": 0},
                                  runner=runner, sleep=clock.sleep, clock=clock)
        self.assertEqual(code, 4)
        self.assertLessEqual(clock.now, INSTALL.WARM_WAIT_SECONDS + 2 * (INSTALL.WARM_REPORT_SECONDS + INSTALL.WARM_POLL_SECONDS))

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
        self.assertIn("resume hook unavailable", out)

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

    def flat(self, runner):
        return [" ".join(c) for c in runner.calls]

    def test_configure_runs_new_release_with_models_and_state(self):
        code, out, err, runner = self.run_deploy(lambda: {"busy": 0})
        self.assertEqual(code, 0, err)
        cmd = [c for c in self.flat(runner) if "configure.py" in c][0]
        self.assertIn(str(self.prefix / "releases/0.4.0/configure.py"), cmd)
        self.assertIn("--models %s" % (self.root / "models.json"), cmd)
        self.assertIn("--state-dir %s" % (self.root / "state"), cmd)
        self.assertTrue(cmd.endswith("--replace"))

    def test_configure_failure_rolls_back(self):
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, runner=FakeRunner(fail_on="configure.py"))
        self.assertEqual(code, 5)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")
        self.assertEqual(json.loads(self.bridge.read_text())["guard_entry"], "old")

    def test_idle_recheck_before_switch_aborts(self):
        states = iter([{"busy": 0}, {"busy": 1}])
        code, out, err, runner = self.run_deploy(lambda: next(states))
        self.assertEqual(code, 3)
        self.assertIn("before switch", err)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")
        self.assertFalse(any("configure.py" in c for c in self.flat(runner)))

    def test_idle_recheck_before_restart_reverts_switch(self):
        states = iter([{"busy": 0}, {"busy": 0}, {"pending": {self.project: 1}}])
        code, out, err, runner = self.run_deploy(lambda: next(states), restart=True)
        self.assertEqual(code, 3)
        self.assertIn("before restart", err)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")
        self.assertFalse((self.prefix / "previous").is_symlink())
        self.assertEqual(json.loads(self.bridge.read_text())["guard_entry"], "old")
        self.assertFalse(any("service" in c for c in self.flat(runner)))

    def test_restart_failure_rolls_back_to_previous(self):
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, restart=True, runner=FakeRunner(fail_on="service start"))
        self.assertEqual(code, 5)
        self.assertIn("rolled current back to 0.3.9", err)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")

    def test_workrelay_fast_forward_step(self):
        wr = str(self.root / "wr")
        code, out, err, runner = self.run_deploy(lambda: {"busy": 0}, workrelay_dir=wr, workrelay_ref="origin/main")
        self.assertEqual(code, 0, err)
        flat = self.flat(runner)
        self.assertIn("git -C %s fetch origin" % wr, flat)
        self.assertIn("git -C %s merge --ff-only origin/main" % wr, flat)
        self.assertFalse(any("stash" in c or "reset" in c or "checkout" in c for c in flat))
        self.assertIn("workrelay fast-forwarded", out)

    def test_workrelay_conflict_aborts_step_only(self):
        code, out, err, runner = self.run_deploy(lambda: {"busy": 0}, workrelay_dir=str(self.root / "wr"),
                                                 workrelay_ref="origin/main", runner=FakeRunner(fail_on="--ff-only"))
        self.assertEqual(code, 0, err)
        self.assertIn("workrelay update aborted", out)
        self.assertIn("nothing was discarded", out)

    def test_default_resume_calls_resume_interrupted_all(self):
        (self.root / "workrelay/src/workrelay").mkdir(parents=True)
        self.bridge.write_text(json.dumps({"guard_entry": "old", "authorized_owner": "owner1"}))
        runner = FakeRunner(resume_available=True)
        code, out, err, _ = self.run_deploy(lambda: {"busy": 0}, resume_command=None, runner=runner)
        self.assertEqual(code, 0, err)
        flat = self.flat(runner)
        self.assertTrue(any(c.endswith("workrelay.cli --config %s resume-interrupted --help" % self.bridge) for c in flat))
        run = [c for c in flat if "--all-interrupted" in c][0]
        self.assertIn("resume-interrupted --owner owner1 --restart-id deploy-", run)
        self.assertIn("PYTHONPATH=%s" % (self.root / "workrelay/src"), run)
        self.assertIn("resume hook exit 0", out)

    def test_projects_from_full_auto_config(self):
        (self.root / "state/config/configure-choices.json").write_text(json.dumps(
            {"full_auto_projects": [{"directory": self.project}, "/abs/other"]}))
        context = INSTALL.DeployContext(self.prefix, args())
        self.assertEqual(context.projects, [self.project, "/abs/other"])

    def test_no_projects_refused_without_force(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = INSTALL.deploy(self.prefix, args(), probe=lambda: {"busy": 0}, runner=FakeRunner(), sleep=lambda s: None)
        self.assertEqual(code, 3)
        self.assertIn("no projects", err.getvalue())

    def test_count_pending_parses_json(self):
        self.assertEqual(INSTALL.count_pending('[{"id": "per_1"}, {"id":"per_2"}, {"id": "x"}]'), 2)
        self.assertEqual(INSTALL.count_pending('{"data": [{"id": "per_1"}]}'), 1)
        self.assertEqual(INSTALL.count_pending(''), 0)
        with self.assertRaises(INSTALL.InstallError):
            INSTALL.count_pending("not json")


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

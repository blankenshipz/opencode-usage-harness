"""0.4.1: a vendored claude-auth adapter is part of the verified release, and the
deploy dry run runs the same verification as a real deploy (r40c regression:
the dry run passed, then the real deploy failed on the adapter's
node_modules/.bin symlinks that were copied in after staging)."""
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
INSTALLER = ROOT / "install.py"
SPEC = importlib.util.spec_from_file_location("harness_installer_vendored", INSTALLER)
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)
ADAPTER = "plugins/v2/claude-auth"


def deploy_args(release, **overrides):
    base = dict(release=release, wait=0, restart=False, dry_run=False, force=False, project=None, root=None,
                env_file=None, bridge=None, gateway_dir=None, opencode_db=None, backup_dir=None,
                resume_command="", skip_validate=False)
    base.update(overrides)
    return argparse.Namespace(**base)


class Runner:
    def __init__(self, release):
        self.release = release

    def __call__(self, argv, cwd=None, timeout=60):
        if "/api/plugin" in argv:
            return 0, '{"path":"/p/releases/%s/plugins"}' % self.release
        return 0, ""


class VendoredReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.prefix = self.root / "harness"
        self.project = self.root / "proj"
        self.project.mkdir()
        self.adapter = self.adapter_tree(self.root / "adapter")

    def tearDown(self):
        self.temp.cleanup()

    def adapter_tree(self, path):
        (path / "dist").mkdir(parents=True)
        (path / "index.mjs").write_text("export * from './dist/index.js';\n")
        (path / "dist/index.js").write_text("export default {};\n")
        (path / "package.json").write_text('{"name":"opencode-claude-auth","version":"3.0.0"}\n')
        (path / "node_modules/rimraf/dist").mkdir(parents=True)
        (path / "node_modules/rimraf/dist/bin.mjs").write_text("#!/usr/bin/env node\n")
        os.chmod(path / "node_modules/rimraf/dist/bin.mjs", 0o755)
        (path / "node_modules/.bin").mkdir()
        os.symlink("../rimraf/dist/bin.mjs", path / "node_modules/.bin/rimraf")
        os.symlink("dist", path / "node_modules/rimraf/lib")  # symlinked directory inside the tree
        return path

    def source(self, version):
        source = self.root / ("source-" + version)
        source.mkdir()
        (source / "VERSION").write_text(version + "\n")
        (source / "README.md").write_text("readme\n")
        shutil.copy2(INSTALLER, source / "install.py")
        (source / "configure.py").write_text("print('configure')\n")
        (source / "plugins/v2").mkdir(parents=True)
        (source / "plugins/v2/full-auto.mjs").write_text("export {};\n")
        (source / "src").mkdir()
        (source / "src/tool.py").write_text("x = 1\n")
        return source

    def cli(self, *argv):
        return subprocess.run([sys.executable, str(INSTALLER), "--prefix", str(self.prefix), *argv], text=True, capture_output=True)

    def deploy(self, release, **kw):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = INSTALL.deploy(self.prefix, deploy_args(release, project=[str(self.project)], root=str(self.root), **kw),
                                      probe=lambda: {"pending": 0, "busy": 0}, runner=Runner(release), sleep=lambda s: None)
            except INSTALL.InstallError as error:
                return 1, out.getvalue(), str(error)
        return code, out.getvalue(), err.getvalue()

    def legacy_current(self):
        """A pre-0.4.1 live release: adapter hand-copied in after staging, plus runtime bytecode."""
        self.assertEqual(self.cli("stage", "--source", str(self.source("0.3.9"))).returncode, 0)
        release = self.prefix / "releases/0.3.9"
        shutil.copytree(self.adapter, release / ADAPTER, symlinks=True)
        (release / "src/__pycache__").mkdir()
        (release / "src/__pycache__/tool.cpython-313.pyc").write_bytes(b"\0")
        os.symlink(release, self.prefix / "current")
        return release

    def test_copied_in_adapter_fails_dry_run_like_real_deploy(self):
        self.legacy_current()
        self.assertEqual(self.cli("stage", "--source", str(self.source("0.4.0"))).returncode, 0)
        shutil.copytree(self.adapter, self.prefix / "releases/0.4.0" / ADAPTER, symlinks=True)  # what r40/stage.sh did
        dry = self.deploy("0.4.0", dry_run=True)
        real = self.deploy("0.4.0")
        self.assertNotEqual(dry[0], 0)
        self.assertIn("claude-auth/node_modules", dry[2])
        self.assertIn("--vendor-claude-auth", dry[2])
        self.assertEqual(dry[2], real[2])
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")

    def test_vendored_stage_verifies_and_deploys(self):
        self.legacy_current()
        staged = self.cli("stage", "--source", str(self.source("0.4.1")), "--vendor-claude-auth", str(self.adapter))
        self.assertEqual(staged.returncode, 0, staged.stderr)
        release = self.prefix / "releases/0.4.1"
        self.assertEqual(os.readlink(release / ADAPTER / "node_modules/.bin/rimraf"), "../rimraf/dist/bin.mjs")
        manifest = json.loads((release / "manifest.json").read_text())
        self.assertEqual([v["path"] for v in manifest["vendored"]], [ADAPTER])
        self.assertFalse(any(f["path"].startswith(ADAPTER) for f in manifest["files"]))
        INSTALL.validate_release(release)
        code, out, err = self.deploy("0.4.1", dry_run=True)
        self.assertEqual(code, 0, err)
        self.assertIn("preflight: release, current and previous verified", out)
        code, out, err = self.deploy("0.4.1")
        self.assertEqual(code, 0, err)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.4.1")
        self.assertEqual(Path(os.readlink(self.prefix / "previous")).name, "0.3.9")
        # Restaging the same version with the same adapter is idempotent; a different adapter is refused.
        self.assertEqual(self.cli("stage", "--source", str(self.source_again("0.4.1")), "--vendor-claude-auth", str(self.adapter)).returncode, 0)
        (self.adapter / "dist/index.js").write_text("export default {changed: true};\n")
        self.assertIn("source differs", self.cli("stage", "--source", str(self.root / "source-0.4.1"), "--vendor-claude-auth", str(self.adapter)).stderr)
        # Rollback to the legacy release still works.
        rolled = self.cli("rollback")
        self.assertEqual(rolled.returncode, 0, rolled.stderr)
        self.assertEqual(Path(os.readlink(self.prefix / "current")).name, "0.3.9")

    def source_again(self, version):
        return self.root / ("source-" + version)

    def test_tampered_vendored_file_or_new_symlink_is_rejected(self):
        self.assertEqual(self.cli("stage", "--source", str(self.source("0.4.1")), "--vendor-claude-auth", str(self.adapter)).returncode, 0)
        release = self.prefix / "releases/0.4.1"
        (release / ADAPTER / "dist/index.js").write_text("tampered\n")
        with self.assertRaisesRegex(INSTALL.InstallError, "vendored tree does not match"):
            INSTALL.validate_release(release)
        (release / ADAPTER / "dist/index.js").write_text("export default {};\n")
        INSTALL.validate_release(release)
        os.symlink("../rimraf/dist/bin.mjs", release / ADAPTER / "node_modules/.bin/extra")
        with self.assertRaisesRegex(INSTALL.InstallError, "vendored tree does not match"):
            INSTALL.validate_release(release)

    def test_escaping_symlinks_are_refused_at_stage(self):
        for target in ("../../../../etc/passwd", "/etc/passwd"):
            with self.subTest(target=target):
                link = self.adapter / "node_modules/.bin/evil"
                os.symlink(target, link)
                result = self.cli("stage", "--source", str(self.source("0.4.1-" + str(len(target)))), "--vendor-claude-auth", str(self.adapter))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("escapes its tree", result.stderr)
                link.unlink()

    def test_legacy_adapter_only_accepted_for_existing_pointers(self):
        legacy = self.legacy_current()
        INSTALL.validate_release(legacy, legacy_vendor_ok=True)
        self.assertEqual(INSTALL.link_target(self.prefix, "current"), legacy.resolve())
        with self.assertRaises(INSTALL.InstallError):
            INSTALL.validate_release(legacy)
        # A non-bytecode file hidden in __pycache__ is still unknown payload.
        (legacy / "src/__pycache__/payload.mjs").write_text("x\n")
        with self.assertRaisesRegex(INSTALL.InstallError, "unknown or missing"):
            INSTALL.validate_release(legacy, legacy_vendor_ok=True)

    def test_skip_validate_dry_run_says_so(self):
        self.assertEqual(self.cli("stage", "--source", str(self.source("0.4.1"))).returncode, 0)
        code, out, _ = self.deploy("0.4.1", dry_run=True, skip_validate=True)
        self.assertEqual(code, 0)
        self.assertIn("verification skipped", out)


if __name__ == "__main__":
    unittest.main()

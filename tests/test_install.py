import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "install.py"
SPEC = importlib.util.spec_from_file_location("harness_installer", INSTALLER)
assert SPEC is not None and SPEC.loader is not None
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.prefix = self.root / "prefix"
        self.state = self.root / "state"
        self.state.mkdir()
        (self.state / "keep").write_text("unchanged")

    def tearDown(self):
        self.temp.cleanup()

    def source(self, version="1.0.0"):
        source = self.root / ("source-" + version)
        source.mkdir()
        (source / "VERSION").write_text(version + "\n")
        (source / "LICENSE").write_text("license\n")
        (source / "NOTICE").write_text("notice\n")
        (source / "README.md").write_text("readme\n")
        shutil.copy2(INSTALLER, source / "install.py")
        (source / "configure.py").write_text("print('configure')\n")
        for dirname in ("bin", "src", "plugins", "config", "compat", "docs"):
            (source / dirname).mkdir()
        (source / "compat" / "patch.mjs").write_text("export {};\n")
        (source / "docs" / "usage.md").write_text("usage\n")
        (source / "bin" / "codex-quota").write_text("#!/bin/sh\necho quota\n")
        (source / "bin" / "harness-metrics").write_text("#!/bin/sh\necho metrics\n")
        os.chmod(source / "bin" / "codex-quota", 0o755)
        os.chmod(source / "bin" / "harness-metrics", 0o755)
        (source / "src" / "tool.py").write_text("x = 1\n")
        return source

    def invoke(self, *args):
        return subprocess.run([sys.executable, str(INSTALLER), "--prefix", str(self.prefix), *args], text=True, capture_output=True)

    def test_install_status_and_wrappers_preserve_state(self):
        source = self.source()
        result = self.invoke("install", "--source", str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.prefix / "current").is_symlink())
        self.assertEqual((self.prefix / "current").resolve().name, "1.0.0")
        self.assertTrue((self.prefix / "current" / "configure.py").is_file())
        self.assertTrue((self.prefix / "current" / "compat").is_dir())
        self.assertTrue((self.prefix / "current" / "docs").is_dir())
        self.assertEqual((self.state / "keep").read_text(), "unchanged")
        status = self.invoke("--state-dir", str(self.state), "status")
        self.assertEqual(status.returncode, 0, status.stderr)
        self.assertEqual(json.loads(status.stdout)["current"], "1.0.0")
        quota = subprocess.run([str(self.prefix / "bin" / "codex-quota")], text=True, capture_output=True)
        self.assertEqual(quota.returncode, 0, quota.stderr)
        self.assertEqual(quota.stdout.strip(), "quota")
        managed = subprocess.run([str(self.prefix / "bin" / "harness-manage"), "status"], text=True, capture_output=True)
        self.assertEqual(managed.returncode, 0, managed.stderr)
        self.assertEqual(json.loads(managed.stdout)["current"], "1.0.0")

    def test_same_version_tampering_is_rejected(self):
        source = self.source()
        self.assertEqual(self.invoke("install", "--source", str(source)).returncode, 0)
        (source / "src" / "tool.py").write_text("x = 2\n")
        result = self.invoke("update", "--source", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs", result.stderr)

    def test_private_payload_in_config_is_rejected(self):
        source = self.source()
        (source / "config" / "auth.json").write_text('{"token": "secret"}\n')
        result = self.invoke("install", "--source", str(source))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("secret, generated, or binary", result.stderr)

    def test_update_then_rollback(self):
        first = self.source("1.0.0")
        second = self.source("1.1.0")
        (second / "src" / "tool.py").write_text("x = 11\n")
        self.assertEqual(self.invoke("install", "--source", str(first)).returncode, 0)
        self.assertEqual(self.invoke("update", "--source", str(second)).returncode, 0)
        self.assertEqual((self.prefix / "current").resolve().name, "1.1.0")
        rollback = self.invoke("rollback")
        self.assertEqual(rollback.returncode, 0, rollback.stderr)
        self.assertEqual((self.prefix / "current").resolve().name, "1.0.0")
        self.assertEqual((self.prefix / "previous").resolve().name, "1.1.0")

    def test_corrupt_manifest_and_unknown_source_are_rejected(self):
        source = self.source()
        self.assertEqual(self.invoke("install", "--source", str(source)).returncode, 0)
        (self.prefix / "current" / "manifest.json").resolve().write_text("not json")
        self.assertNotEqual(self.invoke("status").returncode, 0)
        other = self.source("2.0.0")
        (other / "secret.txt").write_text("no")
        result = self.invoke("update", "--source", str(other))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown source", result.stderr)

    def test_partial_copy_failure_keeps_current_release(self):
        first = self.source("1.0.0")
        self.assertEqual(self.invoke("install", "--source", str(first)).returncode, 0)
        bad = self.source("1.1.0")
        real_copy = shutil.copy2
        calls = 0

        def fail_during_copy(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated interrupted copy")
            return real_copy(*args, **kwargs)

        with mock.patch.object(INSTALL.shutil, "copy2", side_effect=fail_during_copy):
            with self.assertRaises(OSError):
                INSTALL.install(self.prefix, bad)
        self.assertEqual((self.prefix / "current").resolve().name, "1.0.0")

    def test_wrapper_failure_keeps_current_release(self):
        first = self.source("1.0.0")
        second = self.source("1.1.0")
        self.assertEqual(self.invoke("install", "--source", str(first)).returncode, 0)
        with mock.patch.object(INSTALL, "wrappers", side_effect=OSError("simulated wrapper failure")):
            with self.assertRaises(OSError):
                INSTALL.install(self.prefix, second)
        self.assertEqual((self.prefix / "current").resolve().name, "1.0.0")

    def test_prefix_symlink_is_rejected(self):
        target = self.root / "target"
        target.mkdir()
        self.prefix.symlink_to(target, target_is_directory=True)
        result = self.invoke("install", "--source", str(self.source()))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink", result.stderr)

    def test_fresh_checkout_metadata_and_bytecode_are_excluded(self):
        source = self.source()
        for dirname in ("tests", "scripts", ".github", ".git"):
            (source / dirname).mkdir()
            (source / dirname / "checkout-only.txt").write_text("not installed\n")
        (source / ".gitignore").write_text("__pycache__/\n")
        for name in ("SECURITY.md", "CHANGELOG.md", "CONTRIBUTING.md"):
            (source / name).write_text("documentation\n")
        cache = source / "src" / "__pycache__"
        cache.mkdir()
        (cache / "tool.cpython-311.pyc").write_bytes(b"generated")
        (source / "src" / "stray.pyc").write_bytes(b"generated")
        result = self.invoke("install", "--source", str(source))
        self.assertEqual(result.returncode, 0, result.stderr)
        current = (self.prefix / "current").resolve()
        self.assertTrue((current / "SECURITY.md").is_file())
        self.assertFalse((current / "tests").exists())
        self.assertFalse((current / "scripts").exists())
        self.assertFalse((current / ".github").exists())
        self.assertFalse((current / "src" / "__pycache__").exists())
        self.assertFalse((current / "src" / "stray.pyc").exists())
        (source / "auth.json").write_text("secret")
        rejected = self.invoke("update", "--source", str(source))
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("unknown source", rejected.stderr)


if __name__ == "__main__":
    unittest.main()

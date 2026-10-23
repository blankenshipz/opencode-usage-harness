import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("preflight", ROOT / "src/release_preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class StagedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.prefix = self.directory / "install"
        # Actual installer, generated wrappers, generated config and staged
        # plugins: the source tree is not what gets imported or exercised.
        run = subprocess.run([sys.executable, str(ROOT / "install.py"), "--prefix",
                              str(self.prefix), "stage", "--source", str(ROOT)],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertFalse((self.prefix / "current").exists())
        self.version = (ROOT / "VERSION").read_text().strip()
        self.release = self.prefix / "releases" / self.version
        models = self.directory / "models.json"
        models.write_text(json.dumps({k: "openai/test#medium" for k in
                                      ["FAST", "BALANCED", "STRONG", "MAXIMUM"]}))
        self.state = self.directory / "state"
        subprocess.run([sys.executable, str(self.release / "configure.py"), "--models",
                        str(models), "--state-dir", str(self.state)], check=True,
                       capture_output=True)
        self.node = shutil.which("node")
        if not self.node:
            self.skipTest("Node required for installed entry-point checks")
        self.node = Path(self.node).resolve()
        self.entries = [self.release / "plugins/v2" / role / "index.mjs" for role in
                        ["subscription-guard", "task-outcomes", "large-file-context", "model-status"]]
        self.artifacts = [self.state / "config/opencode.json", *sorted((self.prefix / "staged-bin").iterdir())]

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self):
        return preflight.snapshot(self.release / "plugins", self.artifacts, self.entries, self.node)

    def test_actual_staged_entrypoints_and_generated_config_are_verified(self):
        receipt = self.snapshot()
        self.assertTrue(preflight.verify(receipt)["verified"])
        inventory = {r["path"] for r in receipt["files"]}
        self.assertTrue(all(str(entry) in inventory for entry in self.entries))
        config = json.loads(self.artifacts[0].read_text())
        self.assertTrue(all(str(self.release) in entry for entry in config["plugins"]))

    def test_config_and_launcher_drift_are_rejected_before_activation(self):
        for path in self.artifacts:
            receipt = self.snapshot()
            old = path.read_bytes()
            path.write_bytes(old + b"\n")
            with self.assertRaisesRegex(preflight.PreflightError, "artifact drift"):
                preflight.verify(receipt)
            path.write_bytes(old)

    def test_missing_dependency_fails_even_with_matching_hashes(self):
        entry = self.entries[0]
        entry.write_text("import './missing-release-dependency.mjs';\n")
        with self.assertRaisesRegex(preflight.PreflightError, "entry import failed"):
            self.snapshot()

    def test_staged_generated_guard_entry_executes_only_fake_quota(self):
        fake = self.directory / "fake-quota"
        fake.write_text("#!" + str(self.node) + "\n" +
                        "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));\n")
        fake.chmod(0o700)
        script = """
          import {pathToFileURL} from 'node:url';
          import assert from 'node:assert/strict';
          const {createV2Guard} = await import(pathToFileURL(process.argv[1]).href);
          let tool;
          const close = await createV2Guard({quotaCommand:process.argv[2], env:{
            HOME:process.argv[3], PATH:'/usr/bin:/bin', LANG:'C',
            OPENAI_API_KEY:'fixture-secret-never-forward', ANTHROPIC_API_KEY:'fixture-secret-never-forward'
          }}).setup({provider:{transform:async()=>{}},
            tool:{transform:async cb=>cb({add:t=>{tool=t}})},
            session:{hook:async()=>{}},event:{subscribe:()=>({async *[Symbol.asyncIterator](){}})}});
          try {
            const keys = JSON.parse((await tool.execute({})).content);
            // macOS may inject its own text-encoding metadata into execve.
            assert.deepEqual(keys.filter(k=>k!=='__CF_USER_TEXT_ENCODING'),['HOME','LANG','PATH']);
          } finally {close();}
        """
        result = subprocess.run([str(self.node), "--input-type=module", "-e", script,
                                 str(self.entries[0]), str(fake), str(self.directory)],
                                capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr.decode()[-1500:])

    def test_missing_node_and_added_plugin_are_rejected(self):
        receipt = self.snapshot()
        (self.release / "plugins/v2/unreviewed.mjs").write_text("export {};\n")
        with self.assertRaisesRegex(preflight.PreflightError, "inventory drift"):
            preflight.verify(receipt)
        with self.assertRaises(preflight.PreflightError):
            preflight.snapshot(self.release / "plugins", self.artifacts, self.entries,
                               self.directory / "missing-node")

    def activate(self, receipt):
        file = self.directory / "provenance.json"
        file.write_text(json.dumps(receipt))
        return subprocess.run([sys.executable, str(ROOT / "install.py"), "--prefix",
                               str(self.prefix), "activate", "--version", self.version,
                               "--provenance", str(file)], capture_output=True, text=True)

    def test_preflight_blocks_activation_on_config_or_validator_drift(self):
        receipt = self.snapshot()
        validator = self.release / "config/guard-validation.mjs"
        self.assertIn(str(validator), {r["path"] for r in receipt["files"]})
        validator.write_text(validator.read_text() + "\n")
        result = self.activate(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.prefix / "current").exists())

    def test_activation_requires_valid_staged_provenance(self):
        receipt = self.snapshot()
        config = self.artifacts[0]
        old = config.read_bytes()
        config.write_bytes(old + b"\n")
        self.assertNotEqual(self.activate(receipt).returncode, 0)
        self.assertFalse((self.prefix / "current").exists())
        config.write_bytes(old)
        result = self.activate(receipt)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.prefix / "current").resolve(), self.release.resolve())

    def test_missing_dependency_blocks_activation_even_when_resealed(self):
        receipt = self.snapshot()
        entry = self.entries[0]
        entry.write_text("import './missing-release-dependency.mjs';\n")
        # Simulate a broken but byte-consistent candidate, rather than testing
        # only tamper detection. Dependency resolution itself must reject it.
        import hashlib
        manifest_path = self.release / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        for record in manifest["files"]:
            if record["path"] == entry.relative_to(self.release).as_posix():
                record["sha256"] = hashlib.sha256(entry.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        for record in receipt["files"]:
            if record["path"] in {str(entry), str(manifest_path)}:
                record["sha256"] = hashlib.sha256(Path(record["path"]).read_bytes()).hexdigest()
        result = self.activate(receipt)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("entry import failed", result.stderr)
        self.assertFalse((self.prefix / "current").exists())


if __name__ == "__main__":
    unittest.main()

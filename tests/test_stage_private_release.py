import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/stage_private_release.py"


def digest_tree(root):
    digest = hashlib.sha256()
    for file in sorted(root.rglob("*")):
        if file.is_file():
            digest.update(file.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha256(file.read_bytes()).hexdigest().encode() + b"\n")
    return digest.hexdigest()


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


class StagePrivateReleaseTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.public = self.root / "public"; self.private = self.root / "private"; self.output = self.root / "stage"
        (self.public / "plugins").mkdir(parents=True); (self.public / "support").mkdir(); (self.private / "config").mkdir(parents=True)
        (self.public / "plugins/main.mjs").write_text("import './dependency.mjs'; import '../support/helper.mjs'; export default 1;\n")
        (self.public / "plugins/dependency.mjs").write_text("export const publicValue = 1;\n")
        (self.public / "support/helper.mjs").write_text("export const helper = true;\n")
        (self.private / "config/AGENTS.md").write_text("private role instructions\n")

    def tearDown(self): self.temp.cleanup()

    def plan(self, overlays=None):
        plan = {"schema": 1, "public_trees": [{"source": "plugins", "sha256": digest_tree(self.public / "plugins")}, {"source": "support", "sha256": digest_tree(self.public / "support")}], "overlays": overlays or [], "adapters": [], "required": ["plugins/main.mjs", "config/AGENTS.md"]}
        plan["overlays"].append({"source": "config/AGENTS.md", "destination": "config/AGENTS.md", "sha256": digest(self.private / "config/AGENTS.md"), "reason": "private instructions"})
        file = self.root / "plan.json"; file.write_text(json.dumps(plan)); return file

    def invoke(self, command, plan):
        return subprocess.run([sys.executable, str(SCRIPT), command, "--source", str(self.public), "--private-input", str(self.private), "--plan", str(plan), "--output", str(self.output)], text=True, capture_output=True)

    def test_stages_verified_public_tree_and_reviewed_overlay(self):
        plan = self.plan(); self.assertEqual(self.invoke("stage", plan).returncode, 0)
        self.assertEqual(self.invoke("verify", plan).returncode, 0)
        manifest = json.loads((self.output / "manifest.json").read_text())
        self.assertEqual(manifest["overlays"][0]["reason"], "private instructions")
        self.assertTrue(any(item["path"] == "config/AGENTS.md" for item in manifest["files"]))

    def test_rejects_private_overlay_and_staged_file_drift(self):
        plan = self.plan(); (self.private / "config/AGENTS.md").write_text("changed\n")
        result = self.invoke("stage", plan); self.assertNotEqual(result.returncode, 0); self.assertIn("private overlay drift", result.stderr)
        (self.private / "config/AGENTS.md").write_text("private role instructions\n")
        plan = self.plan(); self.assertEqual(self.invoke("stage", plan).returncode, 0)
        (self.output / "config/AGENTS.md").write_text("changed after review\n")
        result = self.invoke("verify", plan); self.assertNotEqual(result.returncode, 0); self.assertIn("staged file drift", result.stderr)

    def test_rejects_source_drift_and_missing_relative_dependency(self):
        plan = self.plan(); (self.public / "plugins/dependency.mjs").write_text("export const publicValue = 2;\n")
        result = self.invoke("stage", plan); self.assertNotEqual(result.returncode, 0); self.assertIn("public source drift", result.stderr)
        (self.public / "plugins/dependency.mjs").unlink(); plan = self.plan()
        result = self.invoke("stage", plan); self.assertNotEqual(result.returncode, 0); self.assertIn("missing staged dependency", result.stderr)

    def test_rejects_symlinked_private_parent(self):
        (self.private / "config/AGENTS.md").unlink(); (self.private / "config").rmdir()
        external = self.root / "external"; external.mkdir(); (external / "AGENTS.md").write_text("private role instructions\n")
        (self.private / "config").symlink_to(external, target_is_directory=True)
        result = self.invoke("stage", self.plan())
        self.assertNotEqual(result.returncode, 0); self.assertIn("symlink in path", result.stderr)

    def test_verifier_rejects_symlinked_staged_parent(self):
        plan = self.plan(); self.assertEqual(self.invoke("stage", plan).returncode, 0)
        original = (self.output / "config/AGENTS.md").read_text()
        (self.output / "config/AGENTS.md").unlink(); (self.output / "config").rmdir()
        external = self.root / "external-stage"; external.mkdir(); (external / "AGENTS.md").write_text(original)
        (self.output / "config").symlink_to(external, target_is_directory=True)
        result = self.invoke("verify", plan)
        self.assertNotEqual(result.returncode, 0); self.assertIn("symlink in staged path", result.stderr)

    def test_verifier_rejects_unmanifested_or_symlinked_dependency(self):
        plan = self.plan(); self.assertEqual(self.invoke("stage", plan).returncode, 0)
        manifest_file = self.output / "manifest.json"; manifest = json.loads(manifest_file.read_text())
        manifest["files"] = [item for item in manifest["files"] if item["path"] != "support/helper.mjs"]
        manifest_file.write_text(json.dumps(manifest))
        result = self.invoke("verify", plan)
        self.assertNotEqual(result.returncode, 0); self.assertIn("missing staged dependency", result.stderr)
        manifest["files"].append({"path": "support/helper.mjs", "sha256": digest(self.output / "support/helper.mjs")})
        manifest_file.write_text(json.dumps(manifest))
        helper = (self.output / "support/helper.mjs").read_text(); (self.output / "support/helper.mjs").unlink(); (self.output / "support").rmdir()
        external = self.root / "external-dependency"; external.mkdir(); (external / "helper.mjs").write_text(helper)
        (self.output / "support").symlink_to(external, target_is_directory=True)
        result = self.invoke("verify", plan)
        self.assertNotEqual(result.returncode, 0); self.assertIn("symlink in staged path", result.stderr)

    def test_rejects_symlinked_public_tree_parent(self):
        (self.public / "alias").symlink_to(self.public, target_is_directory=True)
        plan_path = self.plan()
        plan = json.loads(plan_path.read_text())
        plan["public_trees"][0]["source"] = "alias/plugins"
        plan_path.write_text(json.dumps(plan))
        result = self.invoke("stage", plan_path)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("symlink in source path", result.stderr)

#!/usr/bin/env python3
"""Reproduce native recovery fixtures without writing to the supplied source.

Supply a reviewed managed source baseline, Bun, and an isolated pinned Effect
installation. No dependencies are downloaded and no inference is performed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--bun", type=Path, required=True)
    parser.add_argument("--effect-module", type=Path, required=True)
    args = parser.parse_args()
    baseline = json.loads((ROOT / "compat/opencode-2.0.30-managed-baseline.json").read_text())
    effect = args.effect_module.resolve(strict=True)
    package = effect.parent.parent
    if json.loads((package / "package.json").read_text())["version"] != baseline["effect_version"]:
        parser.error("Effect version differs from the pinned test dependency")
    for name, digest in baseline["files"].items():
        if hashlib.sha256((args.source / name).read_bytes()).hexdigest() != digest:
            parser.error("managed source baseline differs: " + name)
    with tempfile.TemporaryDirectory(prefix="harness-native-recovery-") as temp:
        stage = Path(temp)
        files = list(baseline["files"]) + ["packages/core/src/kv.ts", "packages/core/src/id/id.ts",
            "packages/core/src/session.ts", "packages/core/src/session/message.ts", "packages/core/src/session/schema.ts"]
        for name in files:
            destination = stage / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(args.source / name, destination)
        subprocess.run(["git", "apply", "--check", str(ROOT / "compat/opencode-2.0.30-managed-recovery.patch")], cwd=stage, check=True)
        subprocess.run(["git", "apply", str(ROOT / "compat/opencode-2.0.30-managed-recovery.patch")], cwd=stage, check=True)
        for name, digest in baseline["patched_files"].items():
            if hashlib.sha256((stage / name).read_bytes()).hexdigest() != digest:
                parser.error("patched source differs: " + name)
        # Only Effect executes. Job/Session/storage/app composition are mocked
        # by the fixtures. The local stub gives Bun a resolvable module identity.
        modules = stage / "node_modules"
        modules.mkdir()
        (modules / "effect").symlink_to(package)
        util = modules / "@opencode/util"
        util.mkdir(parents=True)
        (util / "package.json").write_text(json.dumps({"name": "@opencode/util", "type": "module",
            "exports": {"./effect/app-node": "./app-node.js"}}))
        (util / "app-node.js").write_text("export const makeGlobalNode = value => value;\n")
        env = {"PATH": os.defpath, "HOME": temp, "LANG": "C",
               "HARNESS_NATIVE_SOURCE": str(stage), "HARNESS_EFFECT_MODULE": str(effect)}
        # Separate processes isolate Bun's module mocks between the real Job
        # service test and the SubagentJob test's mocked Job service.
        for fixture in ["job-generation.test.ts", "subagent-recovery.test.ts"]:
            subprocess.run([str(args.bun.resolve(strict=True)), "test", str(ROOT / "tests/native" / fixture)],
                           cwd=stage, env=env, check=True, timeout=30)
    print("Native managed patch: baseline and output hashes verified; offline fixtures passed.")


if __name__ == "__main__":
    main()

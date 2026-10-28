#!/usr/bin/env python3
"""Build and verify an offline private release candidate from reviewed inputs.

The command only writes the requested staging directory.  Private inputs are
read through an explicit overlay list, whose hashes are part of the review
plan and the resulting manifest; no activation or service operation exists
here.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from verify_runtime_release import ReleaseVerificationError, verify_release


class StageError(RuntimeError):
    pass


def sha256(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not value or path == Path("."):
        raise StageError(f"unsafe relative path: {value!r}")
    return path


def regular(root: Path, name: str) -> Path:
    file = root
    for part in relative(name).parts:
        file /= part
        if file.is_symlink():
            raise StageError(f"symlink in path: {name}")
    if not file.is_file():
        raise StageError(f"expected regular file: {name}")
    return file


def directory(root: Path, name: str) -> Path:
    tree = root
    for part in relative(name).parts:
        tree /= part
        if tree.is_symlink():
            raise StageError(f"symlink in source path: {name}")
    if not tree.is_dir():
        raise StageError(f"expected source tree: {name}")
    return tree


def tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    for file in sorted(root.rglob("*")):
        if file.is_symlink():
            raise StageError(f"symlink in source tree: {file.relative_to(root)}")
        if file.is_file() and "__pycache__" not in file.parts and file.suffix != ".pyc":
            name = file.relative_to(root).as_posix()
            digest.update(name.encode() + b"\0" + sha256(file).encode() + b"\n")
    return digest.hexdigest()


def load_plan(path: Path) -> dict:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise StageError(f"invalid plan: {error}") from error
    if not isinstance(plan, dict) or plan.get("schema") != 1:
        raise StageError("plan schema must be 1")
    for key in ("public_trees", "overlays", "adapters", "required"):
        if not isinstance(plan.get(key), list):
            raise StageError(f"plan {key} must be a list")
    return plan


def copy_tree(source_root: Path, destination: Path, source: str) -> list[str]:
    tree = directory(source_root, source)
    names = []
    for file in sorted(tree.rglob("*")):
        if file.is_symlink():
            raise StageError(f"symlink in source tree: {source}/{file.relative_to(tree)}")
        if not file.is_file() or "__pycache__" in file.parts or file.suffix == ".pyc":
            continue
        name = (relative(source) / file.relative_to(tree)).as_posix()
        target = destination / relative(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(file, target)
        os.chmod(target, file.stat().st_mode & 0o777)
        names.append(name)
    return names


def build(args: argparse.Namespace) -> None:
    source, private, output = args.source.resolve(), args.private_input.resolve(), args.output.resolve()
    plan_path = args.plan.resolve()
    plan = load_plan(plan_path)
    if output.exists():
        raise StageError(f"output already exists: {output}")
    if not source.is_dir() or not private.is_dir():
        raise StageError("source and private input must be directories")
    destination_names: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="private-release-", dir=output.parent) as temporary:
        stage = Path(temporary) / "release"
        stage.mkdir()
        for entry in plan["public_trees"]:
            if not isinstance(entry, dict):
                raise StageError("public_trees entries must be objects")
            source_name = entry.get("source")
            expected = entry.get("sha256")
            if not isinstance(source_name, str) or not isinstance(expected, str):
                raise StageError("public tree needs source and sha256")
            actual = tree_digest(directory(source, source_name))
            if actual != expected:
                raise StageError(f"public source drift: {source_name}")
            for name in copy_tree(source, stage, source_name):
                if name in destination_names:
                    raise StageError(f"duplicate staged path: {name}")
                destination_names.add(name)
        overlay_manifest = []
        for entry in plan["overlays"]:
            if not isinstance(entry, dict):
                raise StageError("overlays entries must be objects")
            source_name, destination_name, expected, reason = (entry.get(key) for key in ("source", "destination", "sha256", "reason"))
            if not all(isinstance(value, str) and value for value in (source_name, destination_name, expected, reason)):
                raise StageError("overlay needs source, destination, sha256, and reason")
            source_file = regular(private, source_name)
            actual = sha256(source_file)
            if actual != expected:
                raise StageError(f"private overlay drift: {source_name}")
            destination_file = stage / relative(destination_name)
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source_file, destination_file)
            os.chmod(destination_file, source_file.stat().st_mode & 0o777)
            destination_names.add(relative(destination_name).as_posix())
            overlay_manifest.append({"destination": relative(destination_name).as_posix(), "reason": reason, "sha256": actual})
        adapter_manifest = []
        for entry in plan["adapters"]:
            if not isinstance(entry, dict):
                raise StageError("adapters entries must be objects")
            source_name, destination_name, expected, reason, replacements = (entry.get(key) for key in ("source", "destination", "sha256", "reason", "replacements"))
            if not all(isinstance(value, str) and value for value in (source_name, destination_name, expected, reason)) or not isinstance(replacements, list):
                raise StageError("adapter needs source, destination, sha256, reason, and replacements")
            source_file = regular(source, source_name)
            if sha256(source_file) != expected:
                raise StageError(f"public adapter source drift: {source_name}")
            payload = source_file.read_text(encoding="utf-8")
            labels = []
            for replacement in replacements:
                if not isinstance(replacement, dict) or not all(isinstance(replacement.get(key), str) and replacement[key] for key in ("from", "to", "label")):
                    raise StageError("adapter replacement needs from, to, and label")
                if payload.count(replacement["from"]) != 1:
                    raise StageError(f"adapter replacement is ambiguous or absent: {replacement['label']}")
                payload = payload.replace(replacement["from"], replacement["to"])
                labels.append(replacement["label"])
            destination_file = stage / relative(destination_name)
            destination_file.parent.mkdir(parents=True, exist_ok=True)
            destination_file.write_text(payload, encoding="utf-8")
            os.chmod(destination_file, source_file.stat().st_mode & 0o777)
            destination_names.add(relative(destination_name).as_posix())
            adapter_manifest.append({"destination": relative(destination_name).as_posix(), "reason": reason, "replacements": labels, "sha256": sha256(destination_file)})
        for name in plan["required"]:
            if not isinstance(name, str):
                raise StageError("required entries must be paths")
            regular(stage, name)
        files = [{"path": name, "sha256": sha256(stage / name)} for name in sorted(destination_names)]
        manifest = {"schema": 1, "plan_sha256": sha256(plan_path), "public_trees": plan["public_trees"], "overlays": overlay_manifest, "adapters": adapter_manifest, "files": files}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        try:
            verify_release(stage)
        except ReleaseVerificationError as error:
            raise StageError(str(error)) from error
        stage.rename(output)


def verify(args: argparse.Namespace) -> None:
    stage = args.output.resolve()
    try:
        manifest = verify_release(stage)
    except ReleaseVerificationError as error:
        raise StageError(str(error)) from error
    if manifest.get("plan_sha256") != sha256(args.plan.resolve()):
        raise StageError("staged manifest plan mismatch")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("stage", "verify"))
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--private-input", type=Path, required=True)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        (build if args.command == "stage" else verify)(args)
    except StageError as error:
        print(f"stage-private-release: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

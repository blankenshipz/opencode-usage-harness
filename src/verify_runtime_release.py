"""Offline verification for a staged private runtime release.

This module is intentionally dependency-free so a private launcher can import
``verify_release`` before activation.  It validates every recorded staged byte,
including launchers, configuration and AGENTS files when the stage plan listed
them, and rejects missing relative JavaScript dependencies.
"""
from __future__ import annotations

import hashlib
import json
import posixpath
import re
from pathlib import Path


class ReleaseVerificationError(RuntimeError):
    pass


def _relative(value: str) -> Path:
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or not value or path == Path("."):
        raise ReleaseVerificationError(f"unsafe relative path: {value!r}")
    return path


def _sha256(file: Path) -> str:
    return hashlib.sha256(file.read_bytes()).hexdigest()


def _regular(root: Path, name: str) -> Path:
    file = root
    for part in _relative(name).parts:
        file /= part
        if file.is_symlink():
            raise ReleaseVerificationError(f"symlink in staged path: {name}")
    if not file.is_file():
        raise ReleaseVerificationError(f"expected regular file: {name}")
    return file


_IMPORT = re.compile(r"(?:import|export)\s+(?:[^'\"]+?\s+from\s+)?['\"](\.[^'\"]+)['\"]|import\s*\(\s*['\"](\.[^'\"]+)['\"]\s*\)")


def _check_dependencies(stage: Path, files: set[str]) -> None:
    for name in files:
        if not name.endswith(".mjs"):
            continue
        file = _regular(stage, name)
        if file.is_symlink():
            raise ReleaseVerificationError(f"symlink in staged runtime: {file.relative_to(stage)}")
        for match in _IMPORT.findall(file.read_text(encoding="utf-8")):
            imported = next(value for value in match if value)
            relative = file.relative_to(stage).as_posix()
            base = posixpath.normpath(posixpath.join(posixpath.dirname(relative), imported))
            if base == ".." or base.startswith("../") or base == ".":
                raise ReleaseVerificationError(f"unsafe staged dependency: {name} imports {imported}")
            candidates = (base, f"{base}.mjs", f"{base}/index.mjs")
            resolved = next((candidate for candidate in candidates if candidate in files), None)
            if resolved is None:
                raise ReleaseVerificationError(f"missing staged dependency: {file.relative_to(stage)} imports {imported}")
            _regular(stage, resolved)


def verify_release(stage: str | Path, manifest_name: str = "manifest.json") -> dict:
    """Verify a stage without reading a source checkout or changing runtime state."""
    root = Path(stage).resolve()
    try:
        manifest = json.loads(_regular(root, manifest_name).read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise ReleaseVerificationError(f"invalid staged manifest: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or not isinstance(manifest.get("files"), list):
        raise ReleaseVerificationError("invalid staged manifest schema")
    seen = set()
    for record in manifest["files"]:
        if not isinstance(record, dict) or not isinstance(record.get("path"), str) or not isinstance(record.get("sha256"), str):
            raise ReleaseVerificationError("invalid staged file record")
        name = _relative(record["path"]).as_posix()
        if name in seen:
            raise ReleaseVerificationError(f"duplicate staged file record: {name}")
        if _sha256(_regular(root, name)) != record["sha256"]:
            raise ReleaseVerificationError(f"staged file drift: {name}")
        seen.add(name)
    plugins = root / "plugins" / "v2"
    if plugins.exists():
        if plugins.is_symlink() or not plugins.is_dir():
            raise ReleaseVerificationError("invalid staged plugin inventory")
        actual = {file.relative_to(root).as_posix() for file in plugins.rglob("*") if file.is_file()}
        expected = {name for name in seen if name.startswith("plugins/v2/")}
        if actual != expected:
            raise ReleaseVerificationError("unexpected or missing staged plugin inventory")
    _check_dependencies(root, seen)
    return manifest

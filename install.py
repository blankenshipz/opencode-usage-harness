#!/usr/bin/env python3
"""Offline installer for the OpenCode subscription harness.

This program deliberately installs only a reviewed local source tree.  It never
downloads code or modifies a user's OpenCode, OpenChamber, or authentication
configuration.
"""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import sys
import uuid
from pathlib import Path, PurePosixPath


PROGRAM = "opencode-usage-harness"
DEFAULT_PREFIX = Path.home() / ".local" / "share" / PROGRAM
DEFAULT_STATE = Path.home() / ".local" / "state" / PROGRAM
# This is intentionally a release payload allowlist.  The documentation files
# are carried with a release; known checkout-only paths are ignored below.
ROOT_FILES = {
    "VERSION", "LICENSE", "NOTICE", "README.md", "SECURITY.md",
    "CHANGELOG.md", "CONTRIBUTING.md", "pyproject.toml", "package.json",
    "install.py", "configure.py",
}
ROOT_DIRS = {"plugins", "src", "bin", "config", "compat", "docs"}
IGNORED_ROOT_FILES = {".gitignore"}
IGNORED_ROOT_DIRS = {".git", ".github", "tests", "scripts"}
DENIED_PATH_PARTS = {"state", "private", "secrets", "credentials"}
DENIED_FILE_NAMES = {
    ".env", "auth.json", "financial-verification.json", "credential.json",
    "credentials.json", "secret.json", "secrets.json", "token.json",
    "tokens.json", "state.json",
}
DENIED_SUFFIXES = (
    ".bak", ".bin", ".db", ".dll", ".dylib", ".exe", ".key", ".lock",
    ".log", ".p12", ".pem", ".pfx", ".pyc", ".pyo", ".so", ".sqlite",
    ".sqlite3", ".swp", ".tmp",
)
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*$")


class InstallError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise InstallError(message)


def checked_prefix(value: str | Path) -> Path:
    raw = Path(value).expanduser()
    if not raw.is_absolute():
        fail("--prefix must be an absolute path")
    if ".." in raw.parts:
        fail("--prefix must not contain path traversal")
    if raw.exists() or raw.is_symlink():
        if raw.is_symlink() or not raw.is_dir():
            fail("install prefix must be a real directory, not a symlink or file")
    return raw


def checked_state(value: str | None) -> Path:
    state = Path(value).expanduser() if value else Path(os.environ.get("HARNESS_STATE_DIR", DEFAULT_STATE)).expanduser()
    # State is intentionally only reported.  The installer never creates or edits it.
    return state


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_relative(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "." in path.parts:
        fail("unsafe manifest path: %r" % name)
    return path


def scan_source(source: Path) -> tuple[str, list[dict[str, object]]]:
    """Return an allowlisted file inventory from a source-only checkout."""
    if source.is_symlink() or not source.is_dir():
        fail("source must be a real directory")
    version_file = source / "VERSION"
    if version_file.is_symlink() or not version_file.is_file():
        fail("source is missing a regular VERSION file")
    version = version_file.read_text(encoding="utf-8").strip()
    if not VERSION_RE.fullmatch(version):
        fail("VERSION is invalid")

    inventory: list[dict[str, object]] = []
    for entry in sorted(source.iterdir(), key=lambda item: item.name):
        # Known checkout-only paths are not release payload.  This permits a
        # fresh tagged checkout while keeping the actual payload fail-closed.
        if entry.name in IGNORED_ROOT_DIRS and entry.is_dir() and not entry.is_symlink():
            continue
        if entry.name in IGNORED_ROOT_FILES and entry.is_file() and not entry.is_symlink():
            continue
        if entry.name == "__pycache__" and entry.is_dir() and not entry.is_symlink():
            continue
        if entry.name.endswith(".pyc") and entry.is_file() and not entry.is_symlink():
            continue
        if entry.name.startswith(".") or entry.name == "__pycache__":
            fail("unknown source entry: %s" % entry.name)
        if entry.is_symlink():
            fail("source symlinks are not allowed: %s" % entry.name)
        if entry.is_file():
            if entry.name not in ROOT_FILES:
                fail("unknown source file: %s" % entry.name)
            inventory.append(file_record(source, entry))
        elif entry.is_dir():
            if entry.name not in ROOT_DIRS:
                fail("unknown source directory: %s" % entry.name)
            for nested in sorted(entry.rglob("*"), key=lambda item: item.as_posix()):
                relative = nested.relative_to(source)
                # Generated Python bytecode is never packaged.  A symlink with
                # such a name is still rejected below before this exception.
                if nested.is_symlink():
                    fail("source symlinks are not allowed: %s" % relative)
                if "__pycache__" in relative.parts or nested.name.endswith(".pyc"):
                    continue
                if nested.is_dir():
                    continue
                if not nested.is_file():
                    fail("source contains a non-regular file: %s" % relative)
                reject_private_payload(relative)
                inventory.append(file_record(source, nested))
        else:
            fail("source contains a non-regular entry: %s" % entry.name)
    if not (source / "install.py").is_file():
        fail("source is missing install.py")
    return version, inventory


def file_record(root: Path, path: Path) -> dict[str, object]:
    relative = path.relative_to(root).as_posix()
    return {"path": relative, "sha256": sha256(path), "mode": stat.S_IMODE(path.stat().st_mode)}


def reject_private_payload(relative: Path) -> None:
    """Refuse known state, credential, generated, and binary payload files."""
    lowered_parts = [part.lower() for part in relative.parts]
    name = lowered_parts[-1]
    if any(part in DENIED_PATH_PARTS for part in lowered_parts[:-1]):
        fail("private or state payload is not allowed: %s" % relative)
    if name in DENIED_FILE_NAMES or name.startswith(".env.") or name.endswith(DENIED_SUFFIXES):
        fail("secret, generated, or binary payload is not allowed: %s" % relative)


def read_manifest(release: Path) -> list[dict[str, object]]:
    manifest_path = release / "manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        fail("release has no regular manifest.json")
    try:
        parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
        files = parsed["files"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        fail("release manifest is corrupt: %s" % error)
    if not isinstance(files, list) or not files:
        fail("release manifest has no files")
    return files


def validate_release(release: Path) -> list[dict[str, object]]:
    if release.is_symlink() or not release.is_dir():
        fail("release is not a real directory")
    files = read_manifest(release)
    expected: set[str] = set()
    for record in files:
        if not isinstance(record, dict) or set(record) != {"path", "sha256", "mode"}:
            fail("release manifest has an invalid record")
        name, digest, mode = record["path"], record["sha256"], record["mode"]
        if not isinstance(name, str) or not isinstance(digest, str) or not isinstance(mode, int):
            fail("release manifest has invalid values")
        safe_relative(name)
        if name in expected or not re.fullmatch(r"[0-9a-f]{64}", digest):
            fail("release manifest is invalid")
        expected.add(name)
        file_path = release / name
        if (file_path.is_symlink() or not file_path.is_file() or
                sha256(file_path) != digest or stat.S_IMODE(file_path.stat().st_mode) != mode):
            fail("release file does not match manifest: %s" % name)
    actual: set[str] = set()
    for item in release.rglob("*"):
        rel = item.relative_to(release).as_posix()
        if item.is_symlink() or (not item.is_dir() and not item.is_file()):
            fail("release contains unsupported entry: %s" % rel)
        if item.is_file():
            actual.add(rel)
    if actual != expected | {"manifest.json"}:
        fail("release inventory contains unknown or missing files")
    return files


def atomic_link(link: Path, target: Path) -> None:
    temporary = link.with_name(".%s.%s" % (link.name, uuid.uuid4().hex))
    os.symlink(str(target), temporary)
    os.replace(temporary, link)


def link_target(prefix: Path, name: str, required: bool = False) -> Path | None:
    link = prefix / name
    if not link.exists() and not link.is_symlink():
        if required:
            fail("no %s release is available" % name)
        return None
    if not link.is_symlink():
        fail("%s must be a symlink" % link)
    try:
        target = link.resolve(strict=True)
    except OSError as error:
        fail("%s is broken: %s" % (name, error))
    releases_path = prefix / "releases"
    if releases_path.is_symlink():
        fail("releases must be a real directory")
    releases = releases_path.resolve(strict=False)
    try:
        target.relative_to(releases)
    except ValueError:
        fail("%s does not point inside releases" % name)
    validate_release(target)
    return target


def lock_prefix(prefix: Path):
    prefix.mkdir(parents=True, exist_ok=True)
    if prefix.is_symlink():
        fail("install prefix must not be a symlink")
    lock_path = prefix / ".install.lock"
    if lock_path.is_symlink():
        fail("installer lock must not be a symlink")
    handle = lock_path.open("a+")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    return handle


def wrappers(prefix: Path) -> None:
    bin_dir = prefix / "bin"
    if bin_dir.exists() and (bin_dir.is_symlink() or not bin_dir.is_dir()):
        fail("prefix bin must be a real directory")
    bin_dir.mkdir(exist_ok=True)
    mapping = {
        "codex-quota": 'exec "$base/current/bin/codex-quota" "$@"',
        "harness-metrics": 'exec "$base/current/bin/harness-metrics" "$@"',
        # Python is used explicitly so a source checkout need not mark install.py
        # executable; this still executes the installed current/install.py.
        "harness-manage": 'exec python3 "$base/current/install.py" --prefix "$base" "$@"',
    }
    for name, invocation in mapping.items():
        destination = bin_dir / name
        if destination.is_symlink() or (destination.exists() and not destination.is_file()):
            fail("refusing to replace unsafe wrapper: %s" % destination)
        content = "#!/bin/sh\nset -eu\nexport PYTHONDONTWRITEBYTECODE=1\nbase=$(CDPATH= cd -- \"$(dirname -- \"$0\")/..\" && pwd)\n%s\n" % invocation
        temp = destination.with_name(".%s.%s" % (name, uuid.uuid4().hex))
        temp.write_text(content, encoding="utf-8")
        os.chmod(temp, 0o755)
        os.replace(temp, destination)


def install(prefix: Path, source: Path) -> str:
    if platform.system() not in {"Darwin", "Linux"}:
        fail("this installer supports macOS and Linux only")
    version, inventory = scan_source(source)
    lock = lock_prefix(prefix)
    try:
        releases = prefix / "releases"
        if releases.exists() and (releases.is_symlink() or not releases.is_dir()):
            fail("releases must be a real directory")
        releases.mkdir(exist_ok=True)
        destination = releases / version
        if destination.exists() or destination.is_symlink():
            installed = validate_release(destination)
            if installed != inventory:
                fail("source differs from the installed release with the same VERSION")
        else:
            temporary = releases / (".%s.%s" % (version, uuid.uuid4().hex))
            temporary.mkdir()
            try:
                for record in inventory:
                    relative = Path(str(record["path"]))
                    target = temporary / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source / relative, target)
                (temporary / "manifest.json").write_text(json.dumps({"version": version, "files": inventory}, sort_keys=True, indent=2) + "\n", encoding="utf-8")
                validate_release(temporary)
                os.replace(temporary, destination)
            except Exception:
                # A failed staging directory is harmless and retained for diagnosis.
                raise
        old_current = link_target(prefix, "current")
        # Validate an existing rollback pointer before replacing anything.  This
        # also refuses a regular file at a path the installer owns.
        link_target(prefix, "previous")
        # Wrapper setup is part of activation. Do it before changing current so
        # a filesystem or permission failure keeps the working release active.
        wrappers(prefix)
        if old_current is not None and old_current != destination:
            atomic_link(prefix / "previous", old_current)
        atomic_link(prefix / "current", destination)
        return version
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def status(prefix: Path, state: Path) -> dict[str, object]:
    current = link_target(prefix, "current")
    previous = link_target(prefix, "previous")
    return {"prefix": str(prefix), "state_dir": str(state), "current": current.name if current else None, "previous": previous.name if previous else None}


def rollback(prefix: Path) -> str:
    lock = lock_prefix(prefix)
    try:
        current = link_target(prefix, "current", required=True)
        previous = link_target(prefix, "previous", required=True)
        assert current is not None and previous is not None
        # Both targets are validated before either pointer changes.
        atomic_link(prefix / "current", previous)
        try:
            atomic_link(prefix / "previous", current)
        except Exception:
            atomic_link(prefix / "current", current)
            raise
        return previous.name
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Install a reviewed local harness release")
    result.add_argument("--prefix", default=str(DEFAULT_PREFIX))
    result.add_argument("--state-dir", default=None, help="reported only; state is never changed")
    sub = result.add_subparsers(dest="command", required=True)
    for name in ("install", "update"):
        command = sub.add_parser(name)
        command.add_argument("--source", required=True, help="reviewed local source checkout")
    sub.add_parser("status")
    sub.add_parser("rollback")
    return result


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        prefix = checked_prefix(args.prefix)
        state = checked_state(args.state_dir)
        if args.command in {"install", "update"}:
            version = install(prefix, Path(args.source).expanduser())
            print("installed %s" % version)
        elif args.command == "status":
            print(json.dumps(status(prefix, state), sort_keys=True))
        else:
            print("rolled back to %s" % rollback(prefix))
        return 0
    except InstallError as error:
        print("error: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

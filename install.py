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
import importlib.util
import json
import os
import platform
import re
import shutil
import shlex
import stat
import subprocess
import sys
import time
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
ROOT_DIRS = {"plugins", "src", "bin", "config", "compat", "docs", "integrations"}
IGNORED_ROOT_FILES = {".gitignore", ".gitattributes"}
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


def wrappers(prefix: Path, directory: str = "bin") -> None:
    bin_dir = prefix / directory
    if bin_dir.exists() and (bin_dir.is_symlink() or not bin_dir.is_dir()):
        fail("prefix bin must be a real directory")
    bin_dir.mkdir(exist_ok=True)
    mapping = {
        "codex-quota": 'exec "$base/current/bin/codex-quota" "$@"',
        "harness-check": 'exec "$base/current/bin/harness-check" "$@"',
        "harness-metrics": 'exec "$base/current/bin/harness-metrics" "$@"',
        "harness-session-link": 'exec "$base/current/bin/harness-session-link" "$@"',
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


def install(prefix: Path, source: Path, stage_only: bool = False) -> str:
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
        if stage_only:
            wrappers(prefix, "staged-bin")
            return version
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


def activate(prefix: Path, version: str, provenance: Path) -> str:
    """Activate a staged toolkit only after its explicit offline preflight."""
    if not VERSION_RE.fullmatch(version):
        fail("invalid release version")
    lock = lock_prefix(prefix)
    try:
        if (prefix / "releases").is_symlink():
            fail("releases must be a real directory")
        release = prefix / "releases" / version
        validate_release(release)
        receipt = json.loads(provenance.read_text())
        if receipt.get("plugin_root") != str(release.absolute() / "plugins"):
            fail("provenance is for a different staged release")
        # Loading the already hash-validated staged verifier must not generate
        # bytecode in an immutable release.
        before = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            spec = importlib.util.spec_from_file_location("staged_preflight", release / "src/release_preflight.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            module.verify(receipt)
        finally:
            sys.dont_write_bytecode = before
        expected = {r["path"] for r in receipt["files"]}
        staged_launchers = sorted((prefix / "staged-bin").iterdir())
        if not staged_launchers or any(str(p.absolute()) not in expected for p in staged_launchers):
            fail("provenance must include every generated staged launcher")
        old = link_target(prefix, "current")
        link_target(prefix, "previous")
        # Regeneration is deterministic; verify the generated bytes still match
        # the staged launchers before changing the release pointer.
        wrappers(prefix)
        for candidate in staged_launchers:
            if (prefix / "bin" / candidate.name).read_bytes() != candidate.read_bytes():
                fail("generated launcher differs from staged launcher")
        if old and old != release:
            atomic_link(prefix / "previous", old)
        atomic_link(prefix / "current", release)
        return version
    except (OSError, ValueError, KeyError, TypeError, RuntimeError) as error:
        fail("staged activation rejected: " + str(error))
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


# --- restart-safe deploy (parity 4.13) --------------------------------------
# `harness-manage deploy <release>` replaces the hand-run r7-restart/r37 deploy
# scripts.  Every external effect goes through a runner so tests can inject it;
# command output is never echoed because env.sh-sourced commands may see secrets.
DEPLOY_BUSY_EXIT = 3
DEFAULT_RESUME_COMMAND = "python3 -m workrelay.cli resume-after-restart"
COMMIT_HOOK_MARKER = "# harness: prepare-commit-msg attribution"


class DeployContext:
    def __init__(self, prefix: Path, args) -> None:
        self.prefix = prefix
        self.root = Path(args.root).expanduser() if args.root else prefix.parent
        self.env_file = Path(args.env_file).expanduser() if args.env_file else self.root / "env.sh"
        self.bridge = Path(args.bridge).expanduser() if args.bridge else self.root / "workrelay-bridge.json"
        self.gateway = Path(args.gateway_dir).expanduser() if args.gateway_dir else self.root / "gateway"
        self.db = Path(args.opencode_db).expanduser() if args.opencode_db else self.root / "xdg/data/opencode/opencode.db"
        env_projects = [p for p in os.environ.get("HARNESS_DEPLOY_PROJECTS", "").split(":") if p]
        self.projects = [str(Path(p).expanduser()) for p in (args.project or env_projects)]
        self.backups = Path(args.backup_dir).expanduser() if args.backup_dir else self.root / "backups"
        self.config_files = [self.root / "state/config/opencode.json", self.root / "state/config/configure-choices.json", self.bridge, self.gateway / "mcp.json"]
        resume = args.resume_command if args.resume_command is not None else os.environ.get("HARNESS_DEPLOY_RESUME_COMMAND", DEFAULT_RESUME_COMMAND)
        self.resume_command = shlex.split(resume) if resume else []

    def wrapped(self, argv: list[str]) -> list[str]:
        """Run argv with env.sh sourced (when present), output kept private."""
        if self.env_file.is_file():
            return ["bash", "-c", 'set -a; . "$1" >/dev/null 2>&1; set +a; shift; exec "$@"', "harness-deploy", str(self.env_file), *argv]
        return list(argv)


def default_runner(argv: list[str], cwd: str | None = None, timeout: float = 60) -> tuple[int, str]:
    try:
        done = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=timeout)
        return done.returncode, done.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 124, ""


def count_busy_sessions(db: Path, window_hours: float = 6) -> int:
    """Sessions updated in the window that are not idle since their last update (r7-busy.py)."""
    import sqlite3
    if not db.is_file():
        raise InstallError("opencode database not found: %s" % db)
    connection = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
    try:
        now = time.time() * 1000
        row = connection.execute(
            "select count(*) from session_v2 where time_archived is null and (time_idle is null or time_idle < time_updated) and time_updated > ?",
            (now - window_hours * 3600 * 1000,)).fetchone()
        return int(row[0])
    finally:
        connection.close()


def default_probe(context: DeployContext, runner=default_runner) -> dict[str, object]:
    """Pending permission asks per project (r7-pending.sh) plus busy sessions."""
    pending: dict[str, int] = {}
    for project in context.projects:
        code, out = runner(context.wrapped(["opencode", "api", "GET", "/api/permission/request", "-H", "x-opencode-directory:%s" % project]), cwd=project, timeout=10)
        if code != 0:
            raise InstallError("could not query pending asks for %s" % project)
        pending[project] = out.count('"id":"per_')
    return {"pending": pending, "busy": count_busy_sessions(context.db)}


def busy_reasons(probe: dict[str, object]) -> list[str]:
    reasons = []
    for project, count in sorted(dict(probe.get("pending") or {}).items()):
        if count:
            reasons.append("%d pending permission ask(s) in %s" % (count, project))
    busy = int(probe.get("busy") or 0)
    if busy:
        reasons.append("%d busy session(s)" % busy)
    return reasons


def wait_until_idle(probe_fn, wait: float, interval: float = 15, sleep=time.sleep, clock=time.monotonic) -> list[str]:
    deadline = clock() + max(0.0, wait)
    while True:
        reasons = busy_reasons(probe_fn())
        if not reasons or clock() >= deadline:
            return reasons
        print("deploy: waiting, busy: %s" % "; ".join(reasons), flush=True)
        sleep(min(interval, max(0.1, deadline - clock())))


def write_bridge_guard_entry(bridge: Path, release: Path) -> None:
    data = json.loads(bridge.read_text(encoding="utf-8"))
    data["guard_entry"] = str(release / "plugins/v2/subscription-guard/index.mjs")
    mode = stat.S_IMODE(bridge.stat().st_mode)
    temporary = bridge.with_name(".%s.%s" % (bridge.name, uuid.uuid4().hex))
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, indent=2)
        os.replace(temporary, bridge)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def backup_config(context: DeployContext, current: Path | None, previous: Path | None, stamp: str) -> Path:
    destination = context.backups / ("deploy-%s" % stamp)
    destination.mkdir(parents=True, exist_ok=True)
    os.chmod(destination, 0o700)
    for source in context.config_files:
        if source.is_file():
            shutil.copy2(source, destination / source.name)
    (destination / "harness-current.txt").write_text((current.name if current else "") + "\n")
    (destination / "harness-previous.txt").write_text((previous.name if previous else "") + "\n")
    return destination


def deploy_plan(context: DeployContext, release: str, args) -> list[str]:
    plan = [
        "check idle: no pending asks in %d project(s) and no busy sessions%s" % (len(context.projects), " (wait up to %ss)" % args.wait if args.wait else ""),
        "back up config files to %s/deploy-<stamp>" % context.backups,
        "switch current -> releases/%s, previous -> old current" % release,
        "update guard_entry in %s" % context.bridge,
    ]
    if args.restart:
        plan += ["stop gateway (%s/gateway.pid)" % context.gateway, "opencode service stop; opencode service start", "start gateway (%s/start-gateway.sh)" % context.gateway]
    plan.append("warm plugins and verify releases/%s is loaded in: %s" % (release, ", ".join(context.projects) or "(no projects)"))
    plan.append("resume hook: %s" % (" ".join(context.resume_command) if context.resume_command else "(disabled)"))
    return plan


def restart_services(context: DeployContext, runner, sleep=time.sleep) -> None:
    pid_file = context.gateway / "gateway.pid"
    if pid_file.is_file():
        try:
            pid = int(pid_file.read_text().strip())
            os.kill(pid, 15)
            for _ in range(20):
                try:
                    os.kill(pid, 0)
                except OSError:
                    break
                sleep(0.5)
        except (ValueError, OSError):
            pass
    for step in (["opencode", "service", "stop"], ["opencode", "service", "start"]):
        code, _ = runner(context.wrapped(step), cwd=str(context.root), timeout=120)
        if code != 0:
            raise InstallError("%s failed (exit %d)" % (" ".join(step), code))
        sleep(2 if step[-1] == "stop" else 10)
    start = context.gateway / "start-gateway.sh"
    if start.is_file():
        code, _ = runner(context.wrapped(["bash", str(start)]), cwd=str(context.gateway), timeout=120)
        if code != 0:
            raise InstallError("gateway start failed (exit %d)" % code)


def warm_and_verify(context: DeployContext, release: Path, runner) -> dict[str, int]:
    loaded: dict[str, int] = {}
    marker = "releases/%s" % release.name
    for project in context.projects:
        out = ""
        for _ in range(2):  # the first call loads plugins, the second reports them
            _, out = runner(context.wrapped(["opencode", "api", "GET", "/api/plugin", "-H", "x-opencode-directory:%s" % project]), cwd=project, timeout=30)
        loaded[project] = out.count(marker)
    return loaded


def run_resume_hook(context: DeployContext, runner) -> str:
    if not context.resume_command:
        return "resume hook disabled"
    code, _ = runner(context.wrapped([*context.resume_command, "--help"]), cwd=str(context.root), timeout=30)
    if code != 0:
        return "resume hook unavailable, skipped"
    code, _ = runner(context.wrapped(context.resume_command), cwd=str(context.root), timeout=120)
    return "resume hook exit %d" % code


def deploy(prefix: Path, args, probe=None, runner=default_runner, sleep=time.sleep, clock=time.monotonic) -> int:
    if not VERSION_RE.fullmatch(args.release):
        fail("invalid release name")
    context = DeployContext(prefix, args)
    release = prefix / "releases" / args.release
    if not release.is_dir() or release.is_symlink():
        fail("no staged release %s" % args.release)
    if args.dry_run:
        for number, step in enumerate(deploy_plan(context, args.release, args), 1):
            print("%d. %s" % (number, step))
        return 0
    probe_fn = probe or (lambda: default_probe(context, runner))
    reasons = wait_until_idle(probe_fn, float(args.wait or 0), sleep=sleep, clock=clock)
    if reasons and not args.force:
        print("deploy refused, busy: %s" % "; ".join(reasons), file=sys.stderr)
        return DEPLOY_BUSY_EXIT
    if not args.skip_validate:
        validate_release(release)
    lock = lock_prefix(prefix)
    try:
        current = link_target(prefix, "current") if not args.skip_validate else ((prefix / "current").resolve() if (prefix / "current").is_symlink() else None)
        previous = (prefix / "previous").resolve() if (prefix / "previous").is_symlink() else None
        backup = backup_config(context, current, previous, time.strftime("%Y%m%d-%H%M%S"))
        print("backup %s" % backup)
        if current and current != release.resolve():
            atomic_link(prefix / "previous", current)
        atomic_link(prefix / "current", release.absolute())
        print("current -> %s (previous %s)" % (release.name, current.name if current else "none"))
        if context.bridge.is_file():
            write_bridge_guard_entry(context.bridge, release.absolute())
            print("guard_entry updated")
    finally:
        fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
        lock.close()
    if args.restart:
        restart_services(context, runner, sleep=sleep)
        print("restarted opencode service and gateway")
    loaded = warm_and_verify(context, release, runner)
    missing = [p for p, n in loaded.items() if n == 0]
    for project, count in sorted(loaded.items()):
        print("%s: %d plugin(s) from %s" % (project, count, release.name))
    print(run_resume_hook(context, runner))
    if missing:
        print("deploy: release not loaded in: %s" % ", ".join(missing), file=sys.stderr)
        return 4
    print("deployed %s" % release.name)
    return 0


# --- commit attribution hook (parity 4.12) ----------------------------------
PREPARE_COMMIT_MSG = r"""#!/bin/sh
# harness: prepare-commit-msg attribution
# Appends Agent:, Harness-Role: and Workrelay-Session: trailers from
# HARNESS_AGENT, HARNESS_ROLE and WORKRELAY_SESSION_ID.  Unset variables are
# skipped, existing trailers are never duplicated, and author/committer are
# never touched.  A previous hook is chained as prepare-commit-msg.harness-chained.
set -eu
msg="$1"
chained="$(dirname "$0")/prepare-commit-msg.harness-chained"
if [ -x "$chained" ]; then "$chained" "$@"; fi
case "${2:-}" in merge|squash) exit 0 ;; esac
add() {
  [ -n "$2" ] || return 0
  value=$(printf '%s' "$2" | tr -d '\r\n')
  if git interpret-trailers --parse "$msg" | grep -qi "^$1: "; then return 0; fi
  git interpret-trailers --in-place --if-exists addIfDifferent --trailer "$1: $value" "$msg"
}
add Agent "${HARNESS_AGENT:-}"
add Harness-Role "${HARNESS_ROLE:-}"
add Workrelay-Session "${WORKRELAY_SESSION_ID:-}"
"""


def install_commit_hook(repo: Path) -> str:
    """Install the attribution hook; an existing different hook is chained, never clobbered."""
    try:
        hooks = subprocess.run(["git", "-C", str(repo), "rev-parse", "--git-path", "hooks"], capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        fail("%s is not a git repository" % repo)
    hooks_dir = Path(hooks) if os.path.isabs(hooks) else repo / hooks
    hooks_dir.mkdir(parents=True, exist_ok=True)
    destination = hooks_dir / "prepare-commit-msg"
    chained = hooks_dir / "prepare-commit-msg.harness-chained"
    if destination.is_symlink():
        fail("refusing to replace symlinked hook %s" % destination)
    if destination.exists():
        existing = destination.read_text(encoding="utf-8", errors="replace")
        if existing == PREPARE_COMMIT_MSG:
            return "already installed at %s" % destination
        if COMMIT_HOOK_MARKER not in existing:
            if chained.exists() or chained.is_symlink():
                fail("refusing to overwrite existing chained hook %s" % chained)
            os.replace(destination, chained)
    temporary = hooks_dir / (".prepare-commit-msg.%s" % uuid.uuid4().hex)
    temporary.write_text(PREPARE_COMMIT_MSG, encoding="utf-8")
    os.chmod(temporary, 0o755)
    os.replace(temporary, destination)
    return "installed %s%s" % (destination, " (chained previous hook)" if chained.exists() else "")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="Install a reviewed local harness release")
    result.add_argument("--prefix", default=str(DEFAULT_PREFIX))
    result.add_argument("--state-dir", default=None, help="reported only; state is never changed")
    sub = result.add_subparsers(dest="command", required=True)
    for name in ("install", "update", "stage"):
        command = sub.add_parser(name)
        command.add_argument("--source", required=True, help="reviewed local source checkout")
    command = sub.add_parser("activate")
    command.add_argument("--version", required=True)
    command.add_argument("--provenance", type=Path, required=True)
    sub.add_parser("status")
    sub.add_parser("rollback")
    command = sub.add_parser("deploy", help="restart-safe switch to a staged release")
    command.add_argument("release", help="staged release name under <prefix>/releases")
    command.add_argument("--wait", type=float, default=0, metavar="SECONDS", help="poll until idle for up to SECONDS")
    command.add_argument("--restart", action="store_true", help="stop gateway, restart opencode service, start gateway")
    command.add_argument("--dry-run", action="store_true", help="print the plan only")
    command.add_argument("--force", action="store_true", help="deploy even when busy")
    command.add_argument("--project", action="append", help="project directory to check/warm (repeatable; default $HARNESS_DEPLOY_PROJECTS)")
    command.add_argument("--root", help="deployment root (default: parent of --prefix)")
    command.add_argument("--env-file", help="env file sourced for opencode commands (default <root>/env.sh)")
    command.add_argument("--bridge", help="workrelay-bridge.json (default <root>/workrelay-bridge.json)")
    command.add_argument("--gateway-dir", help="gateway directory (default <root>/gateway)")
    command.add_argument("--opencode-db", help="opencode.db for busy sessions (default <root>/xdg/data/opencode/opencode.db)")
    command.add_argument("--backup-dir", help="backup directory (default <root>/backups)")
    command.add_argument("--resume-command", default=None, help="resume-after-restart command; empty string disables (default $HARNESS_DEPLOY_RESUME_COMMAND or %s)" % DEFAULT_RESUME_COMMAND)
    command.add_argument("--skip-validate", action="store_true", help="skip manifest validation of the release")
    command = sub.add_parser("install-commit-hook", help="install the prepare-commit-msg attribution hook into a repo")
    command.add_argument("repo", type=Path)
    return result


def main(argv: list[str] | None = None) -> int:
    try:
        args = parser().parse_args(argv)
        prefix = checked_prefix(args.prefix)
        state = checked_state(args.state_dir)
        if args.command in {"install", "update", "stage"}:
            version = install(prefix, Path(args.source).expanduser(), stage_only=args.command == "stage")
            print(("staged %s" if args.command == "stage" else "installed %s") % version)
        elif args.command == "activate":
            print("activated %s" % activate(prefix, args.version, args.provenance))
        elif args.command == "status":
            print(json.dumps(status(prefix, state), sort_keys=True))
        elif args.command == "deploy":
            return deploy(prefix, args)
        elif args.command == "install-commit-hook":
            print(install_commit_hook(args.repo.expanduser()))
        else:
            print("rolled back to %s" % rollback(prefix))
        return 0
    except InstallError as error:
        print("error: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

"""Run one explicitly requested local command and retain a private receipt."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import stat
import shutil
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from .paths import state_dir
except ImportError:  # direct execution via bin/harness-check
    from paths import state_dir


_LABEL = re.compile(r"^[a-z0-9-]{1,64}$")
_SIGNALS = {getattr(signal, name): name for name in ("SIGINT", "SIGTERM") if hasattr(signal, name)}
_DEFAULT_RESERVE_BYTES = 2 * 1024 * 1024 * 1024
_RECEIPT_VERSION = 2
_TERMINAL_OUTCOMES = {"succeeded", "failed", "interrupted", "startup_error", "capacity_blocked", "capacity_unavailable"}


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _replace_receipt(path: Path, document: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".receipt-", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(document, sort_keys=True, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
    finally:
        try:
            temporary_path.unlink()
        except FileNotFoundError:
            pass


def _forward(child: subprocess.Popen[bytes], signum: int) -> None:
    if child.poll() is not None:
        return
    try:
        if os.name == "posix":
            os.killpg(child.pid, signum)
        else:  # start_new_session is unavailable on Windows; terminate the owned child.
            child.send_signal(signum)
    except (ProcessLookupError, OSError):
        pass


def _process_identity(pid: int) -> str | None:
    """Return a birth identity when the host exposes one, without inspecting argv/env."""
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    proc_stat = Path(f"/proc/{pid}/stat")
    try:
        if proc_stat.exists():
            text = proc_stat.read_text(encoding="utf-8")
            after_comm = text.rsplit(")", 1)[1].split()
            # /proc stat field 22 (starttime), after state is index 19.
            boot = Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()
            return f"proc-starttime:{boot}:{after_comm[19]}" if boot else None
    except (OSError, IndexError, UnicodeError):
        pass
    # macOS ps lstart has only second precision and cannot safely distinguish
    # rapid PID reuse. No sufficiently precise portable identity is available.
    return None


def _capacity(path: Path, reserve_bytes: int) -> dict[str, Any]:
    probe = path
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    try:
        usage = shutil.disk_usage(probe)
    except (OSError, ValueError):
        return {"path": str(path), "status": "unavailable", "available_bytes": None}
    return {
        "path": str(path),
        "status": "ok" if usage.free >= reserve_bytes else "blocked",
        "available_bytes": usage.free,
    }


def _reserve_bytes(value: int | None) -> int:
    if value is not None:
        return value
    configured = os.environ.get("HARNESS_MIN_FREE_BYTES")
    if configured is not None:
        try:
            value = int(configured)
        except ValueError as error:
            raise ValueError("HARNESS_MIN_FREE_BYTES must be an integer") from error
    else:
        value = _DEFAULT_RESERVE_BYTES
    if value < 0:
        raise ValueError("reserve bytes must be nonnegative")
    return value


def _health(document: dict[str, Any]) -> str:
    if document.get("receipt_version") != _RECEIPT_VERSION:
        return "unknown"
    outcome = document.get("outcome")
    if outcome in _TERMINAL_OUTCOMES and document.get("finished_at"):
        return "completed"
    pid = document.get("process_pid")
    recorded_identity = document.get("process_identity")
    if outcome != "running":
        return "unknown"
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return "unknown"
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return "owner_missing"
    except PermissionError:
        return "unknown"
    except OSError as error:
        return "owner_missing" if getattr(error, "errno", None) == 3 else "unknown"
    if not isinstance(recorded_identity, str) or not recorded_identity:
        return "unknown"
    current_identity = _process_identity(pid)
    if current_identity is None:
        return "unknown"
    return "running" if current_identity == recorded_identity else "owner_missing"


def inspect_receipt(path: Path) -> dict[str, Any]:
    """Read one receipt without changing it or its owning process."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"path": str(path), "status": "unknown"}
    if not isinstance(document, dict):
        return {"path": str(path), "status": "unknown"}
    return {"path": str(path), "status": _health(document)}


def preview_log(receipt: Path, stream: str = "stderr", offset: int = 1,
                limit: int = 120) -> dict[str, Any]:
    """Read a bounded page from an existing finalized private check log.

    No subprocess, extra cache, automatic deletion, or permission override.
    Originals and process exit evidence remain untouched.
    """
    try:
        from .log_preview import compact_lines
    except ImportError:
        from log_preview import compact_lines
    if stream not in {"stdout", "stderr"} or offset < 1 or not 1 <= limit <= 350:
        raise ValueError("preview requires stdout/stderr, offset >= 1 and limit 1..350")
    root = (state_dir() / "check-receipts").resolve(strict=True)
    receipt = receipt.resolve(strict=True)
    if receipt.name != "receipt.json" or not receipt.is_relative_to(root):
        raise ValueError("preview receipt must be inside the harness check-receipts directory")
    if receipt.stat().st_size > 65536:
        raise ValueError("invalid oversized receipt")
    document = json.loads(receipt.read_text())
    if not isinstance(document, dict) or document.get("outcome") not in _TERMINAL_OUTCOMES:
        raise ValueError("preview requires a finalized check; use check_status while it runs")
    name = stream + ".log"
    if document.get(stream + "_file") != name:
        raise ValueError("receipt has no matching retained log")
    source = receipt.parent / name
    if source.is_symlink() or source.resolve(strict=True).parent != receipt.parent:
        raise ValueError("preview log must be a regular retained file, not a symlink")
    fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode):
            raise ValueError("preview log must be a regular file")
        scanned = 0
        selected_bytes = 0
        lines = []
        reached_end = False
        for number in range(1, offset + limit):
            remaining = 4 * 1024 * 1024 - scanned
            if remaining <= 0:
                raise ValueError("preview scan bound exceeded; use a focused native log search")
            raw = handle.readline(min(65537, remaining))
            scanned += len(raw)
            if len(raw) > 65536 or (len(raw) == remaining and not raw.endswith(b"\n")):
                raise ValueError("preview scan bound exceeded; use a focused native log search")
            if not raw:
                reached_end = True
                break
            if number >= offset:
                if selected_bytes + len(raw) > 65536:
                    handle.seek(-len(raw), os.SEEK_CUR)
                    break
                selected_bytes += len(raw)
                try:
                    lines.append(raw.decode("utf-8"))
                except UnicodeDecodeError as error:
                    raise ValueError("preview requires UTF-8 text; original bytes remain intact") from error
                if selected_bytes >= 65536:
                    break
        if not reached_end and scanned < 4 * 1024 * 1024:
            reached_end = not bool(handle.read(1))
    read_count = len(lines)
    while True:
        result = {"receipt": str(receipt), "source": str(source), "stream": stream,
                  "offset": offset, "lines_read": len(lines),
                  "next_offset": None if reached_end and len(lines) == read_count else offset + len(lines),
                  "source_size_bytes": info.st_size, "source_mtime_ns": info.st_mtime_ns,
                  "scope": "bounded preview, not full-log analysis or acceptance evidence",
                  **compact_lines(lines, offset)}
        if len(json.dumps(result, ensure_ascii=True).encode()) <= 32768:
            return result
        if len(lines) <= 1:
            raise ValueError("preview line exceeds output budget; use a focused native log search")
        lines.pop()


def run(label: str, revision: str | None, command: list[str], reserve_bytes: int | None = None) -> int:
    reserve = _reserve_bytes(reserve_bytes)
    root = state_dir() / "check-receipts"
    capacities = [_capacity(Path.cwd(), reserve), _capacity(root, reserve)]
    if any(item["status"] != "ok" for item in capacities):
        capacity_outcome = "capacity_unavailable" if any(item["status"] == "unavailable" for item in capacities) else "capacity_blocked"
        try:
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.chmod(root, 0o700)
            run_dir = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=root))
            os.chmod(run_dir, 0o700)
            receipt_path = run_dir / "receipt.json"
            _replace_receipt(receipt_path, {
                "receipt_version": _RECEIPT_VERSION,
                "started_at": _timestamp(), "finished_at": _timestamp(),
                "label": label, "revision": revision, "exit_code": 125,
                "child_returncode": None, "signal": None,
                "startup_error": "disk_capacity",
                "outcome": capacity_outcome,
                "capacity": {"reserve_bytes": reserve, "checks": capacities},
                "duration_seconds": 0.0, "stdout_file": None, "stderr_file": None,
                "process_pid": None, "process_identity": None, "heartbeat_at": None,
            })
            print(f"{capacity_outcome}: {receipt_path}")
        except OSError as error:
            print(json.dumps({"status": "unavailable", "error": type(error).__name__, "capacity": capacities}))
        return 125
    try:
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(root, 0o700)
    except OSError as error:
        print(json.dumps({"status": "unavailable", "error": type(error).__name__, "capacity": capacities}))
        return 125
    run_dir = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=root))
    os.chmod(run_dir, 0o700)
    stdout_path = run_dir / "stdout.log"
    stderr_path = run_dir / "stderr.log"
    receipt_path = run_dir / "receipt.json"
    started_at = _timestamp()
    started = time.monotonic()
    stdout_path.touch(mode=0o600)
    stderr_path.touch(mode=0o600)
    os.chmod(stdout_path, 0o600)
    os.chmod(stderr_path, 0o600)
    _replace_receipt(receipt_path, {
        "receipt_version": _RECEIPT_VERSION,
        "started_at": started_at,
        "finished_at": None,
        "label": label,
        "revision": revision,
        "exit_code": None,
        "child_returncode": None,
        "signal": None,
        "startup_error": None,
        "outcome": "running",
        "duration_seconds": 0.0,
        "stdout_file": stdout_path.name,
        "stderr_file": stderr_path.name,
        "process_pid": None,
        "process_identity": None,
        "heartbeat_at": started_at,
        "capacity": {"reserve_bytes": reserve, "checks": capacities},
    })
    print(f"running: {receipt_path}", flush=True)
    child: subprocess.Popen[bytes] | None = None
    process_identity: str | None = None
    interrupted_by: int | None = None

    def on_signal(signum: int, _frame: Any) -> None:
        nonlocal interrupted_by
        interrupted_by = signum
        if child is not None:
            _forward(child, signum)

    old_handlers = {sig: signal.getsignal(sig) for sig in _SIGNALS}
    for sig in _SIGNALS:
        signal.signal(sig, on_signal)

    exit_code: int | None = None
    child_returncode: int | None = None
    signal_name: str | None = None
    startup_error: str | None = None
    try:
        with open(stdout_path, "wb", opener=lambda path, flags: os.open(path, flags, 0o600)) as stdout, open(
            stderr_path, "wb", opener=lambda path, flags: os.open(path, flags, 0o600)
        ) as stderr:
            try:
                kwargs: dict[str, Any] = {"stdout": stdout, "stderr": stderr}
                if os.name == "posix":
                    kwargs["start_new_session"] = True
                child = subprocess.Popen(command, **kwargs)
                running_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                running_receipt["process_pid"] = child.pid
                process_identity = _process_identity(child.pid)
                running_receipt["process_identity"] = process_identity
                running_receipt["heartbeat_at"] = _timestamp()
                _replace_receipt(receipt_path, running_receipt)
                if interrupted_by is not None:
                    _forward(child, interrupted_by)
            except OSError as error:
                startup_error = type(error).__name__
                stderr.write(f"{type(error).__name__}: unable to start requested command\n".encode())
            else:
                while True:
                    try:
                        child_returncode = child.wait(timeout=1)
                        break
                    except subprocess.TimeoutExpired:
                        running_receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
                        running_receipt["heartbeat_at"] = _timestamp()
                        _replace_receipt(receipt_path, running_receipt)
                exit_code = child_returncode
                if child_returncode < 0:
                    signal_name = _SIGNALS.get(-child_returncode, f"SIG{-child_returncode}")
    finally:
        for sig, handler in old_handlers.items():
            signal.signal(sig, handler)

    finished_at = _timestamp()
    if interrupted_by is not None:
        signal_name = _SIGNALS.get(interrupted_by, f"SIG{interrupted_by}")
        exit_code = 128 + interrupted_by
        outcome = "interrupted"
    elif startup_error is not None:
        outcome = "startup_error"
        exit_code = 127
    elif exit_code == 0:
        outcome = "succeeded"
    elif exit_code is not None and exit_code < 0:
        exit_code = 128 + (-exit_code)
        outcome = "interrupted"
    else:
        outcome = "failed"
    receipt = {
        "receipt_version": _RECEIPT_VERSION,
        "started_at": started_at,
        "finished_at": finished_at,
        "label": label,
        "revision": revision,
        "exit_code": exit_code,
        "child_returncode": child_returncode,
        "signal": signal_name,
        "startup_error": startup_error,
        "outcome": outcome,
        "duration_seconds": round(max(0.0, time.monotonic() - started), 6),
        "stdout_file": stdout_path.name,
        "stderr_file": stderr_path.name,
        "process_pid": child.pid if child is not None else None,
        "process_identity": process_identity,
        "heartbeat_at": finished_at,
        "capacity": {"reserve_bytes": reserve, "checks": capacities},
    }
    _replace_receipt(receipt_path, receipt)
    print(f"{outcome}: {receipt_path}")
    return int(exit_code if exit_code is not None else 127)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one local command and retain a private diagnostic receipt")
    parser.add_argument("--label")
    parser.add_argument("--revision")
    parser.add_argument("--reserve-bytes", type=int, help="minimum free bytes required on cwd and receipt filesystems")
    parser.add_argument("--preview", metavar="RECEIPT", help="preview a finalized retained log; does not run a command")
    parser.add_argument("--stream", choices=("stdout", "stderr"), default="stderr")
    parser.add_argument("--offset", type=int, default=1)
    parser.add_argument("--limit", type=int, default=120)
    parser.add_argument("--status", metavar="RECEIPT", help="inspect a receipt without changing it or its process")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if args.preview:
        if args.status or args.label or args.command:
            parser.error("--preview cannot run a command or be combined with --status/--label")
        try:
            print(json.dumps(preview_log(Path(args.preview), args.stream, args.offset, args.limit), ensure_ascii=True))
            return 0
        except (OSError, ValueError) as error:
            parser.error(str(error))
    if args.status:
        print(json.dumps(inspect_receipt(Path(args.status)), sort_keys=True, separators=(",", ":")))
        return 0
    if not args.label:
        parser.error("--label is required when running a command")
    if not _LABEL.fullmatch(args.label):
        parser.error("--label must match [a-z0-9-]{1,64}")
    if args.reserve_bytes is not None and args.reserve_bytes < 0:
        parser.error("--reserve-bytes must be nonnegative")
    if args.revision is not None:
        if not args.revision.strip():
            parser.error("--revision must be nonblank")
        if len(args.revision) > 160:
            parser.error("--revision must be at most 160 characters")
        if any(ord(char) < 32 or ord(char) == 127 for char in args.revision):
            parser.error("--revision must not contain control characters")
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command:
        parser.error("a command is required after --")
    try:
        return run(args.label, args.revision, command, args.reserve_bytes)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    raise SystemExit(main())

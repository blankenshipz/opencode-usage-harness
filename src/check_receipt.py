"""Run one explicitly requested local command and retain a private receipt."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
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


def run(label: str, revision: str | None, command: list[str]) -> int:
    root = state_dir() / "check-receipts"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
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
    })
    print(f"running: {receipt_path}", flush=True)
    child: subprocess.Popen[bytes] | None = None
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
                if interrupted_by is not None:
                    _forward(child, interrupted_by)
            except OSError as error:
                startup_error = type(error).__name__
                stderr.write(f"{type(error).__name__}: unable to start requested command\n".encode())
            else:
                child_returncode = child.wait()
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
    }
    _replace_receipt(receipt_path, receipt)
    print(f"{outcome}: {receipt_path}")
    return int(exit_code if exit_code is not None else 127)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one local command and retain a private diagnostic receipt")
    parser.add_argument("--label", required=True)
    parser.add_argument("--revision")
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    if not _LABEL.fullmatch(args.label):
        parser.error("--label must match [a-z0-9-]{1,64}")
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
    return run(args.label, args.revision, command)


if __name__ == "__main__":
    raise SystemExit(main())

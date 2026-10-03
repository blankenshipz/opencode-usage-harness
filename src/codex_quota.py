#!/usr/bin/env python3
"""Read Codex app-server rate limits without exposing account credentials."""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import select
import shutil
import subprocess
import sys
import time
import tempfile
from datetime import datetime, timezone
import math
from pathlib import Path
from typing import Any

try:
    from .paths import quota_cache_path
except ImportError:  # direct execution via bin/codex-quota
    from paths import quota_cache_path

CACHE_SECONDS = 30
SAFE_ENV = ("HOME", "CODEX_HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE")


class QuotaRPCError(RuntimeError):
    """Closed-set failure metadata; never include a provider error payload."""

    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def failure_reason(exc: Exception) -> str:
    if isinstance(exc, QuotaRPCError) and exc.reason in {
        "initialization_failed", "quota_rpc_failed", "invalid_response", "unexpected_eof"
    }:
        return exc.reason
    if isinstance(exc, (TimeoutError, subprocess.TimeoutExpired)):
        return "timeout"
    if isinstance(exc, FileNotFoundError):
        return "executable_missing"
    if isinstance(exc, PermissionError):
        return "permission_denied"
    if isinstance(exc, OSError):
        return "process_io_failed"
    return "unknown_failure"


def _number(value: Any) -> float | None:
    try:
        if value is None or isinstance(value, bool):
            return None
        n = float(value)
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None


def _minutes(window: dict[str, Any]) -> float | None:
    for key in ("windowDurationMins", "window_duration_mins", "durationMins", "duration_mins"):
        n = _number(window.get(key))
        if n is not None:
            return n
    return None


def _bucket_name(bucket: dict[str, Any], index: int) -> str:
    return str(bucket.get("limitId") or bucket.get("limit_id") or bucket.get("name") or bucket.get("id") or f"bucket-{index + 1}")


def _windows(bucket: dict[str, Any]) -> list[dict[str, Any]]:
    value = bucket.get("windows", bucket.get("rateLimits"))
    if isinstance(value, list):
        return [x for x in value if isinstance(x, dict)]
    if isinstance(value, dict):
        return [value]
    return []


def _reset_state(window: dict[str, Any], now: float) -> str:
    reset = window.get("resetsAt", window.get("resets_at"))
    n = _number(reset)
    if n is None:
        return "unknown"
    # App-server timestamps are seconds since epoch; tolerate milliseconds.
    if n > 10_000_000_000:
        n /= 1000
    return "unknown" if n <= now else "known"


def _pace(used: float | None, duration: float | None, window: dict[str, Any], now: float) -> tuple[float | None, float | None, float | None, float | None]:
    """Return window start, elapsed fraction, target used, and pace delta."""
    if duration is None or duration <= 0:
        return None, None, None, None
    reset = _number(window.get("resetsAt", window.get("resets_at")))
    if reset is None:
        return None, None, None, None
    if reset > 10_000_000_000:
        reset /= 1000
    start = reset - duration * 60
    elapsed = max(0.0, min(duration * 60, now - start))
    fraction = elapsed / (duration * 60)
    target = max(0.0, min(100.0, fraction * 100.0))
    delta = None if used is None else used - target
    return start, fraction, target, delta


def _snapshot_buckets(raw: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    mapped = raw.get("rateLimitsByLimitId")
    if isinstance(mapped, dict):
        return [(str(k), v if isinstance(v, dict) else {}) for k, v in mapped.items()]
    one = raw.get("rateLimits")
    return [(str(one.get("limitId") or "default"), one)] if isinstance(one, dict) else []


def normalize(raw: dict[str, Any], now: float | None = None) -> dict[str, Any]:
    """Return stable, conservative quota fields while retaining sanitized raw data."""
    now = time.time() if now is None else now
    normalized: list[dict[str, Any]] = []
    pressure = 0.0
    for name, bucket in _snapshot_buckets(raw):
        ws = []
        for window_name in ("primary", "secondary"):
            window = bucket.get(window_name)
            if not isinstance(window, dict):
                continue
            used = _number(window.get("usedPercent", window.get("used_percent")))
            remaining = _number(window.get("remainingPercent", window.get("remaining_percent")))
            if used is None and remaining is not None:
                used = 100 - remaining
            if remaining is None and used is not None:
                remaining = 100 - used
            if used is not None:
                used = max(0.0, min(100.0, used))
            if remaining is not None:
                remaining = max(0.0, min(100.0, remaining))
            duration = _minutes(window)
            kind = "weekly" if duration is not None and abs(duration - 10080) <= 1 else "short" if duration is not None else "unknown"
            state = _reset_state(window, now)
            start, fraction, target, delta = _pace(used, duration, window, now)
            if remaining is not None:
                pressure = max(pressure, 100 - remaining)
            ws.append({"name": window_name, "duration_minutes": duration, "kind": kind, "used_percent": used, "remaining_percent": remaining, "reset": state, "resets_at": window.get("resetsAt", window.get("resets_at")), "window_start": start, "elapsed_fraction": fraction, "target_used_percent": target, "pace_delta": delta})
        bucket_credits = bucket.get("credits") if isinstance(bucket.get("credits"), dict) else None
        normalized.append({"name": name, "windows": ws, "credits": sanitize(bucket_credits), "rate_limit_reached_type": bucket.get("rateLimitReachedType"), "spend_control_reached": bucket.get("spendControlReached")})
    credits = raw.get("credits") if isinstance(raw.get("credits"), dict) else None
    if credits is None:
        main = raw.get("rateLimits") or {}
        credits = main.get("credits") if isinstance(main.get("credits"), dict) else None
    if credits is None:
        credits = {"hasCredits": raw.get("hasCredits"), "unlimited": raw.get("unlimited"), "balance": raw.get("balance")} if any(k in raw for k in ("hasCredits", "unlimited", "balance")) else None
    credit_risk = "unknown"
    if credits is not None:
        # Preserve distinct earned reset semantics; never conflate with purchased credits.
        vals = [_number(credits.get(k)) for k in ("balance", "remaining", "available")]
        if any(v is not None and v > 0 for v in vals):
            credit_risk = "positive"
        elif credits.get("unlimited") is True or credits.get("hasCredits") is True:
            credit_risk = "positive"
        elif any(v == 0 for v in vals) or credits.get("hasCredits") is False:
            credit_risk = "none"
    for bucket in normalized:
        c = bucket.get("credits") or {}
        balances = [_number(c.get(k)) for k in ('balance', 'available', 'remaining')]
        if c.get("hasCredits") is True or c.get("unlimited") is True or any(v is not None and v > 0 for v in balances):
            credit_risk = "positive"
    reset_credits = raw.get("rateLimitResetCredits")
    return {"checked_at": datetime.fromtimestamp(now, timezone.utc).isoformat(), "buckets": normalized, "pressure_percent": round(max(0.0, min(100.0, pressure)), 2), "credit_risk": credit_risk, "credits": sanitize(credits), "rate_limit_reset_credits": sanitize(reset_credits), "raw": sanitize(raw)}


def sanitize(value: Any) -> Any:
    """Remove account identity and auth-like fields recursively."""
    blocked = {
        "account", "accountId", "account_id", "email", "userId", "user_id",
        "organizationId", "organization_id", "token", "accessToken",
        "refreshToken", "apiKey", "api_key", "secret", "authorization",
    }
    if isinstance(value, dict):
        return {k: sanitize(v) for k, v in value.items() if k not in blocked and str(k).lower() not in {item.lower() for item in blocked}}
    if isinstance(value, list):
        return [sanitize(v) for v in value]
    return value


def _rpc(command: list[str], timeout: float = 20) -> dict[str, Any]:
    env = {k: os.environ[k] for k in SAFE_ENV if k in os.environ}
    proc = subprocess.Popen(command + ["app-server", "--stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    try:
        def call(method: str, ident: int | None, params: dict[str, Any] | None = None) -> None:
            msg = {"jsonrpc": "2.0", "method": method}
            if ident is not None:
                msg.update(id=ident, params=params or {})
            proc.stdin.write((json.dumps(msg) + "\n").encode())
            proc.stdin.flush()
        call("initialize", 1, {"clientInfo": {"name": "codex-quota", "version": "1.0"}, "capabilities": {}})
        deadline = time.monotonic() + timeout
        buffer = b''
        while time.monotonic() < deadline:
            ready, _, _ = select.select([proc.stdout], [], [], max(0.0, deadline - time.monotonic()))
            if not ready:
                break
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                raise QuotaRPCError("unexpected_eof")
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                try:
                    msg = json.loads(line)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(msg, dict):
                    continue
                if msg.get("id") == 1:
                    if 'error' in msg:
                        raise QuotaRPCError("initialization_failed")
                    call("initialized", None)
                    call("account/rateLimits/read", 2, {})
                elif msg.get("id") == 2:
                    if "error" in msg:
                        raise QuotaRPCError("quota_rpc_failed")
                    result = msg.get("result")
                    if not isinstance(result, dict):
                        raise QuotaRPCError("invalid_response")
                    return result
        raise TimeoutError("Codex app-server quota request timed out")
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.communicate(timeout=2)


def read_quota(command: list[str] | None = None, refresh: bool = False, *, cache_path: Path | None = None, timeout: float = 20) -> tuple[dict[str, Any], bool]:
    path = cache_path or quota_cache_path()
    started = time.time()
    deadline = time.monotonic() + timeout

    def cached():
        try:
            item = json.loads(path.read_text())
            stamp = float(item["timestamp"])
            if 0 <= time.time() - stamp <= CACHE_SECONDS and (not refresh or stamp >= started):
                data = normalize(item["data"]["raw"])
                data["checked_at"] = item["data"]["checked_at"]
                return data, True
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return None

    hit = cached()
    if hit is not None:
        return hit
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(path.with_suffix(".lock"), "a") as lock:
        os.chmod(lock.name, 0o600)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Quota refresh lock timed out")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                time.sleep(min(0.05, remaining))
        try:
            hit = cached()
            if hit is not None:
                return hit
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Quota refresh budget exhausted")
            if command is None:
                configured = os.environ.get("HARNESS_CODEX_BIN", "codex")
                executable = shutil.which(configured)
                if not executable:
                    raise FileNotFoundError("codex executable not found")
                command = [executable]
            raw = _rpc(command, timeout=remaining)
            data = normalize(raw)
            temporary = None
            try:
                payload = json.dumps({"timestamp": time.time(), "data": data})
                with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".cache-", delete=False) as fh:
                    temporary = fh.name
                    os.chmod(temporary, 0o600)
                    fh.write(payload)
                os.replace(temporary, path)
            finally:
                if temporary:
                    Path(temporary).unlink(missing_ok=True)
            return data, False
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--json", action="store_true")
    p.add_argument("--refresh", action="store_true")
    p.add_argument("--check", action="store_true")
    args = p.parse_args(argv)
    try:
        data, cached = read_quota(refresh=args.refresh)
    except Exception as exc:
        reason = failure_reason(exc)
        # Machine-readable, closed vocabulary only. No exception text, command,
        # stderr, provider response or credentials may cross this boundary.
        print(f"quota unavailable: {reason}", file=sys.stderr)
        if args.json:
            print(json.dumps({"status": "unavailable", "error": "quota unavailable", "reason": reason}))
        return 2
    if args.check:
        denied = admission_denied(data)
        return 1 if denied else 0
    if args.json:
        print(json.dumps(data, sort_keys=True))
    else:
        print(f"quota pressure {data['pressure_percent']:.0f}%; credits={data['credit_risk']}")
        for bucket in data["buckets"]:
            for window in bucket["windows"]:
                delta = "unknown" if window["pace_delta"] is None else f"{window['pace_delta']:.1f}%"
                reset = datetime.fromtimestamp(window["resets_at"], timezone.utc).astimezone().isoformat() if _number(window["resets_at"]) is not None else "unknown"
                print(f"{bucket['name']} {window['kind']} ({window['duration_minutes']:g} min) used={window['used_percent']}% delta={delta} reset={reset}")
    return 0


def admission_denied(data):
    return (data.get("credit_risk") != "none" or not data.get("buckets")
            or any(not b["windows"] or b.get("rate_limit_reached_type") is not None
                   or b.get("spend_control_reached") is True
                   or any(w["reset"] != "known" or w["remaining_percent"] is None
                          or w["remaining_percent"] <= 0 or w["target_used_percent"] is None
                          for w in b["windows"]) for b in data["buckets"]))


if __name__ == "__main__":
    raise SystemExit(main())

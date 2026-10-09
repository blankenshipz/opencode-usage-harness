"""Read-only reconciliation of native session activity and local session claims."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

try:
    from .paths import opencode_db
except ImportError:
    from paths import opencode_db


_TIMEOUT = 5
_LOOPBACK = {"127.0.0.1", "::1"}
_MAX_RESPONSE_BYTES = 1024 * 1024


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(request.full_url, code, "redirects disabled", headers, fp)


def _service() -> tuple[str, str] | None:
    service_file = os.environ.get("HARNESS_OPENCODE_SERVICE_FILE")
    if service_file:
        try:
            data = json.loads(Path(service_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("url"), str) or not isinstance(data.get("password"), str):
            return None
        return data["url"], data["password"]
    url = os.environ.get("OPENCODE_SERVER_URL")
    password = os.environ.get("OPENCODE_SERVER_PASSWORD")
    return (url, password) if url and password is not None else None


def _validate_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme != "http" or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError("native service URL must be plain HTTP loopback")
    if parts.hostname not in _LOOPBACK or not parts.netloc:
        raise ValueError("native service URL must use literal loopback host")
    return urlunsplit((parts.scheme, parts.netloc, "/api/session/active", "", ""))


def _native_active(url: str, password: str, session_id: str) -> bool | None:
    endpoint = _validate_url(url)
    token = base64.b64encode(f"opencode:{password}".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(endpoint, headers={"Authorization": f"Basic {token}", "Accept": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=_TIMEOUT) as response:
            length = response.headers.get("Content-Length")
            if length is not None and int(length) > _MAX_RESPONSE_BYTES:
                return None
            raw = response.read(_MAX_RESPONSE_BYTES + 1)
            if len(raw) > _MAX_RESPONSE_BYTES:
                return None
            payload = json.loads(raw)
    except (OSError, ValueError, urllib.error.URLError, urllib.error.HTTPError):
        return None
    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, dict):
        return None
    try:
        entry = data[session_id]
    except KeyError:
        return False
    if not isinstance(entry, dict) or not isinstance(entry.get("type"), str):
        return None
    return entry["type"] == "running"


def _session_claim(db_path: Path, session_id: str, caller_id: str | None) -> bool | None:
    connection = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
    try:
        connection.execute("PRAGMA query_only=ON")
        columns = {row[1] for row in connection.execute("PRAGMA table_info(session_v2)")}
        parent = "parent_id" if "parent_id" in columns else "parentID" if "parentID" in columns else None
        if "id" not in columns or "time_suspended" not in columns:
            return None
        row = connection.execute("SELECT time_suspended, " + (parent or "NULL") + " FROM session_v2 WHERE id=?", (session_id,)).fetchone()
        if row is None:
            return None
        if caller_id is not None:
            current = session_id
            seen: set[str] = set()
            allowed = False
            while current and current not in seen:
                seen.add(current)
                if current == caller_id:
                    allowed = True
                    break
                parent_row = connection.execute("SELECT " + (parent or "NULL") + " FROM session_v2 WHERE id=?", (current,)).fetchone()
                current = parent_row[0] if parent_row else None
            if not allowed:
                raise PermissionError("caller is not session owner or ancestor")
        return row[0] is not None
    finally:
        connection.close()


def inspect(session_id: str, *, caller_id: str | None = None, db_path: str | Path | None = None) -> dict[str, Any]:
    """Return health facts; unknown is fail-closed for unavailable evidence."""
    try:
        claimed = _session_claim(Path(db_path) if db_path is not None else opencode_db(), session_id, caller_id)
    except (OSError, RuntimeError, sqlite3.Error, PermissionError) as error:
        return {"session": session_id, "claimed": None, "native_active": None, "assessment": "unknown", "warning": str(error) if isinstance(error, PermissionError) else "local metadata unavailable"}
    service = _service()
    if claimed is None or service is None:
        return {"session": session_id, "claimed": claimed, "native_active": None, "assessment": "unknown", "warning": "native or local metadata unavailable"}
    try:
        native_active = _native_active(service[0], service[1], session_id)
    except ValueError:
        native_active = None
    if native_active is None:
        assessment = "unknown"
    elif native_active:
        assessment = "active"
    elif claimed:
        assessment = "claim_without_owner"
    else:
        assessment = "idle"
    return {"session": session_id, "claimed": claimed, "native_active": native_active, "assessment": assessment, "warning": "activity evidence is not proof of useful progress; operator reconciliation may be needed" if assessment in {"active", "claim_without_owner"} else None}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Inspect native runtime health without changing sessions")
    parser.add_argument("--session", required=True)
    parser.add_argument("--caller", required=True)
    args = parser.parse_args(argv)
    result = inspect(args.session, caller_id=args.caller)
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0 if result["assessment"] != "unknown" or result.get("warning") != "caller is not session owner or ancestor" else 2


if __name__ == "__main__":
    raise SystemExit(main())

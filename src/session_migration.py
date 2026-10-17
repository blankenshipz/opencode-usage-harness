"""Explicit, API-only migration marker for preserved OpenCode sessions.

This helper never changes a session's parent, directory, execution, or title.
It marks an already-preserved copy as historical and points operators to the
canonical session through ordinary authenticated HTTP metadata updates.

The OpenCode API has no atomic idle/version precondition.  Operators must
quiesce sends to the historical chat during --apply; activity checks are
snapshots only and cannot eliminate the race with the final PATCH.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Protocol


DEFAULT_SERVER = "http://127.0.0.1:4096"
DEFAULT_STATE = Path.home() / ".local" / "state" / "opencode-usage-harness"
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
INACTIVITY_CHECK = "snapshot_only"


class MigrationError(RuntimeError):
    pass


class Transport(Protocol):
    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        ...


def validate_id(value: str, label: str) -> str:
    if not ID_RE.fullmatch(value):
        raise MigrationError("%s is malformed" % label)
    return value


def validate_server(server: str) -> str:
    parsed = urllib.parse.urlparse(server)
    if (parsed.scheme not in {"http", "https"} or not parsed.netloc or
            parsed.path not in {"", "/"} or parsed.username or parsed.password or
            parsed.query or parsed.fragment):
        raise MigrationError("--server must be an origin URL")
    if parsed.hostname not in {"127.0.0.1", "::1", "localhost"}:
        raise MigrationError("--server must be loopback")
    return server.rstrip("/")


def session_directory(session: Any) -> str:
    directory = session.get("directory") if isinstance(session, dict) else None
    if directory is None and isinstance(session, dict) and isinstance(session.get("location"), dict):
        directory = session["location"].get("directory")
    if not isinstance(directory, str) or not directory:
        raise MigrationError("session response has no valid directory")
    return directory


def session_metadata(session: Any) -> dict[str, Any]:
    if not isinstance(session, dict):
        raise MigrationError("session response is invalid")
    metadata = session.get("metadata", {})
    if not isinstance(metadata, dict):
        raise MigrationError("session metadata is invalid")
    return metadata


def active_ids(active: Any) -> set[str]:
    """Accept common active-session response shapes while rejecting malformed data."""
    if isinstance(active, dict) and "sessions" in active:
        values = active["sessions"]
    elif isinstance(active, dict) and isinstance(active.get("id"), str):
        values = [active]
    elif isinstance(active, dict):
        found: set[str] = set()
        for session_id, execution in active.items():
            if not isinstance(session_id, str) or not ID_RE.fullmatch(session_id):
                raise MigrationError("active-session response is invalid")
            if not isinstance(execution, dict) or not isinstance(execution.get("type"), str):
                raise MigrationError("active-session response is invalid")
            found.add(session_id)
        return found
    else:
        values = active
    if isinstance(values, dict):
        values = [values]
    if not isinstance(values, list):
        raise MigrationError("active-session response is invalid")
    found: set[str] = set()
    for item in values:
        if isinstance(item, str):
            found.add(item)
        elif isinstance(item, dict) and isinstance(item.get("id"), str):
            found.add(item["id"])
        else:
            raise MigrationError("active-session response is invalid")
    return found


def unwrap_api_data(response: Any) -> Any:
    """Validate and unwrap the OpenCode API's required {data: ...} envelope."""
    if not isinstance(response, dict) or set(response) != {"data"}:
        raise MigrationError("API response is invalid")
    return response["data"]


def merged_historical_metadata(metadata: dict[str, Any], canonical_id: str) -> dict[str, Any]:
    migration = metadata.get("harnessMigration")
    if migration is not None and not isinstance(migration, dict):
        raise MigrationError("existing harnessMigration metadata is invalid")
    if isinstance(migration, dict) and migration.get("historical") is True:
        raise MigrationError("historical session is already marked historical")
    if isinstance(migration, dict) and migration.get("canonicalSessionID"):
        raise MigrationError("historical session already has a canonical link")
    result = dict(metadata)
    result["harnessMigration"] = {"canonicalSessionID": canonical_id, "historical": True}
    return result


def validate_link(historical_id: str, canonical_id: str, historical: Any, canonical: Any, active: Any) -> dict[str, Any]:
    validate_id(historical_id, "--historical")
    validate_id(canonical_id, "--canonical")
    if historical_id == canonical_id:
        raise MigrationError("historical and canonical IDs must differ")
    if not isinstance(historical, dict) or historical.get("id") != historical_id:
        raise MigrationError("historical session response does not match its ID")
    if not isinstance(canonical, dict) or canonical.get("id") != canonical_id:
        raise MigrationError("canonical session response does not match its ID")
    if session_directory(historical) != session_directory(canonical):
        raise MigrationError("sessions must belong to the same directory")
    historical_meta = session_metadata(historical)
    canonical_meta = session_metadata(canonical)
    canonical_migration = canonical_meta.get("harnessMigration")
    if isinstance(canonical_migration, dict):
        if canonical_migration.get("historical") is True:
            raise MigrationError("canonical session is itself historical")
        if canonical_migration.get("canonicalSessionID") == historical_id:
            raise MigrationError("canonical metadata would create a cycle")
    if historical_id in active_ids(active):
        raise MigrationError("historical session has an active execution")
    return merged_historical_metadata(historical_meta, canonical_id)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        raise MigrationError("refusing an HTTP redirect while authenticated")


class HttpTransport:
    def __init__(self, server: str, api_base: str, authorization: str):
        server_origin = validate_server(server)
        parsed = urllib.parse.urlparse(api_base)
        if parsed.scheme or parsed.netloc:
            if parsed.query or parsed.fragment or not parsed.path:
                raise MigrationError("--api-base URL is invalid")
            api_origin = validate_server("%s://%s" % (parsed.scheme, parsed.netloc))
            self.base = api_origin + parsed.path.rstrip("/")
        else:
            if not api_base.startswith("/") or "?" in api_base or "#" in api_base:
                raise MigrationError("--api-base must be an absolute URL path")
            self.base = server_origin + api_base.rstrip("/")
        self.authorization = authorization
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Accept": "application/json", "Authorization": self.authorization,
                     **({"Content-Type": "application/json"} if data else {})},
        )
        try:
            with self.opener.open(request, timeout=15) as response:
                if response.status < 200 or response.status >= 300:
                    raise MigrationError("API returned HTTP %s" % response.status)
                return unwrap_api_data(json.loads(response.read().decode("utf-8")))
        except (urllib.error.URLError, urllib.error.HTTPError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise MigrationError("API request failed: %s" % error) from error


def authorization(token_file: str | None) -> str:
    if token_file:
        path = Path(token_file).expanduser()
        if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
            raise MigrationError("--token-file must be a regular private file (mode 0600)")
        token = path.read_text(encoding="utf-8").strip()
        if not token:
            raise MigrationError("--token-file is empty")
        return "Bearer " + token
    password = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if not password:
        raise MigrationError("set OPENCODE_SERVER_PASSWORD or provide --token-file")
    encoded = base64.b64encode(("opencode:" + password).encode("utf-8")).decode("ascii")
    return "Basic " + encoded


def write_backup(state_dir: Path, historical_id: str, metadata: dict[str, Any]) -> Path:
    if state_dir.is_symlink():
        raise MigrationError("state directory must not be a symlink")
    backup_dir = state_dir / "session-migration-backups"
    backup_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if backup_dir.is_symlink() or not backup_dir.is_dir():
        raise MigrationError("backup directory is unsafe")
    os.chmod(backup_dir, 0o700)
    path = backup_dir / ("%s-%d.json" % (historical_id, time.time_ns()))
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump({"historicalSessionID": historical_id, "metadata": metadata}, handle, sort_keys=True)
        handle.write("\n")
    return path


def migrate(transport: Transport, historical_id: str, canonical_id: str, *, apply: bool, state_dir: Path) -> dict[str, Any]:
    historical = transport.request("GET", "/session/" + urllib.parse.quote(historical_id, safe=""))
    canonical = transport.request("GET", "/session/" + urllib.parse.quote(canonical_id, safe=""))
    active = transport.request("GET", "/session/active")
    metadata = validate_link(historical_id, canonical_id, historical, canonical, active)
    if not apply:
        return {"applied": False, "historical": historical_id, "canonical": canonical_id,
                "inactivity_check": INACTIVITY_CHECK}
    # The API has no conditional PATCH. Re-read just before the write so a
    # concurrent metadata change fails closed instead of being overwritten.
    refreshed = transport.request("GET", "/session/" + urllib.parse.quote(historical_id, safe=""))
    if session_metadata(refreshed) != session_metadata(historical):
        raise MigrationError("historical metadata changed after the snapshot")
    refreshed_active = transport.request("GET", "/session/active")
    validate_link(historical_id, canonical_id, refreshed, canonical, refreshed_active)
    write_backup(state_dir, historical_id, session_metadata(historical))
    transport.request("PATCH", "/session/" + urllib.parse.quote(historical_id, safe=""), {"metadata": metadata})
    return {"applied": True, "historical": historical_id, "canonical": canonical_id,
            "inactivity_check": INACTIVITY_CHECK}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Mark one preserved OpenCode chat as historical; API idle checks are snapshots only")
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--api-base", default="/api")
    parser.add_argument("--historical", required=True)
    parser.add_argument("--canonical", required=True)
    parser.add_argument("--token-file")
    parser.add_argument("--state-dir", default=os.environ.get("HARNESS_STATE_DIR", str(DEFAULT_STATE)))
    parser.add_argument("--apply", action="store_true", help="PATCH metadata after snapshot checks; quiesce sends first (not atomic)")
    args = parser.parse_args(argv)
    try:
        result = migrate(HttpTransport(args.server, args.api_base, authorization(args.token_file)), args.historical, args.canonical,
                         apply=args.apply, state_dir=Path(args.state_dir).expanduser())
        print("applied" if result["applied"] else "dry run: no session metadata changed")
        return 0
    except MigrationError as error:
        print("error: %s" % error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

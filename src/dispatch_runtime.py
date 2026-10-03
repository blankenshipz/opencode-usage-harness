#!/usr/bin/env python3
"""Read-only dispatch ownership/source IDs without prompt or credential output."""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

try:
    from .paths import opencode_db
except ImportError:
    from paths import opencode_db


def _connect(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = opencode_db() if db_path is None else Path(db_path).expanduser()
    connection = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=2)
    connection.execute("PRAGMA query_only=ON")
    return connection


def intent_sources(session_id: str, *, db_path: str | Path | None = None) -> list[str]:
    with _connect(db_path) as connection:
        sources = []
        for ident, raw in connection.execute(
            "SELECT id,data FROM session_message WHERE session_id=? AND type=? ORDER BY seq",
            (session_id, "user"),
        ):
            try:
                item = json.loads(raw)
            except (TypeError, json.JSONDecodeError):
                continue
            body = item.get("text", item.get("payload", {}).get("text", ""))
            if not isinstance(body, str) or not body.strip() or body.startswith("Continue working toward the active session goal."):
                continue
            sources.append(str(ident))
        return sources


def sessions(*, db_path: str | Path | None = None) -> list[dict[str, object]]:
    # Pinned V2 contract: claim() sets this historically named column; release()
    # clears it. Non-null means claimed execution, not proof of useful progress.
    with _connect(db_path) as connection:
        return [
            {"id": row[0], "parentID": row[1], "agent": row[2], "directory": row[3], "active": row[4] is not None, "created": row[5]}
            for row in connection.execute(
                "SELECT id,parent_id,agent,directory,time_suspended,time_created,title FROM session_v2"
            )
        ]


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == "--intent-sources":
        print(json.dumps(intent_sources(args[1])))
        return 0
    print(json.dumps(sessions()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

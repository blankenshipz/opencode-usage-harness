#!/usr/bin/env python3
"""Read-only dispatch ownership/source IDs without prompt or credential output."""

from __future__ import annotations

import json
import hashlib
import math
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


def _completed_context_observation(raw: str, message_id: object) -> tuple[object, object] | None:
    """Return (completed time, context token count) for a usable assistant."""
    try:
        item = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(item, dict) or item.get("error"):
        return None
    if item.get("finish") in ("error", "cancelled", "aborted"):
        return None
    timing = item.get("time")
    completed = timing.get("completed") if isinstance(timing, dict) else None
    if not isinstance(completed, (int, float)) or isinstance(completed, bool) or not math.isfinite(completed) or completed <= 0:
        return None
    tokens = item.get("tokens")
    if not isinstance(tokens, dict):
        return None

    # Native providers use tokens.cache.read/write.  Keep older flat names
    # readable only when the native cache object is absent, while treating
    # present invalid values as invalid rather than silently turning them into
    # zero.
    values = []
    present = False
    if "input" in tokens:
        present = True
        value = tokens["input"]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
            return None
        values.append(value)
    cache = tokens.get("cache")
    if "cache" in tokens:
        if isinstance(cache, dict):
            for key in ("read", "write"):
                if key in cache:
                    present = True
                    value = cache[key]
                    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                        return None
                    values.append(value)
        elif isinstance(cache, (int, float)) and not isinstance(cache, bool) and math.isfinite(cache) and cache >= 0:
            present = True
            values.append(cache)
        else:
            return None
    else:
        for aliases in (("cache_read", "cacheRead"), ("cache_write", "cacheWrite")):
            for key in aliases:
                if key in tokens:
                    present = True
                    value = tokens[key]
                    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value) or value < 0:
                        return None
                    values.append(value)
                    break
    if not present:
        return None
    return completed, sum(values)


def sessions(*, db_path: str | Path | None = None) -> list[dict[str, object]]:
    # Pinned V2 contract: claim() sets this historically named column; release()
    # clears it. Non-null means claimed execution, not proof of useful progress.
    with _connect(db_path) as connection:
        columns = {r[1] for r in connection.execute("pragma table_info(session_v2)")}
        extra = ",model" if "model" in columns else ",null"
        extra += ",metadata" if "metadata" in columns else ",null"
        rows = []
        for row in connection.execute("SELECT id,parent_id,agent,directory,time_suspended,time_created" + extra + " FROM session_v2"):
            item = {"id": row[0], "parentID": row[1], "agent": row[2], "directory": row[3], "active": row[4] is not None, "created": row[5]}
            try:
                model = json.loads(row[6] or "null")
                if isinstance(model, dict):
                    item["model"] = {k: model[k] for k in ("id", "providerID", "variant") if isinstance(model.get(k), str)}
                metadata = json.loads(row[7] or "{}")
                migration = metadata.get("harnessMigration", {})
                if migration.get("historical") is True and isinstance(migration.get("canonicalSessionID"), str):
                    item["canonicalSessionID"] = migration["canonicalSessionID"]
            except (ValueError, TypeError, AttributeError):
                pass
            latest = connection.execute("SELECT id FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 1", (row[0],)).fetchone()
            if latest:
                # This binding is independent of usage validity: an in-flight
                # newest assistant still identifies the native compaction point.
                item["lastAssistantID"] = latest[0]
            if row[1] is None:
                if _native_timestamp(row[4]):
                    item["executionStartedAt"] = row[4]
                visible = connection.execute(
                    "SELECT data FROM session_message WHERE session_id=? AND type='assistant' ORDER BY seq DESC LIMIT 128",
                    (row[0],),
                )
                for assistant_data, in visible:
                    try:
                        assistant = json.loads(assistant_data)
                    except (TypeError, json.JSONDecodeError):
                        continue
                    timing = assistant.get("time") if isinstance(assistant, dict) else None
                    completed = timing.get("completed") if isinstance(timing, dict) else None
                    content = assistant.get("content") if isinstance(assistant, dict) else None
                    if not _native_timestamp(completed) or not isinstance(content, list):
                        continue
                    if any(isinstance(part, dict) and part.get("type") == "text" and isinstance(part.get("text"), str) and part["text"].strip() for part in content):
                        item["lastVisibleTextAt"] = completed
                        break
            compact = connection.execute("SELECT id,json_extract(data,'$.status') FROM session_message WHERE session_id=? AND type='compaction' AND json_extract(data,'$.reason')='manual' ORDER BY seq DESC LIMIT 1", (row[0],)).fetchone()
            if compact and compact[1] in ('running', 'completed', 'failed'):
                item['lastCompaction'] = {'id': compact[0], 'status': compact[1]}
            # A later failed/running manual compaction does not erase the last
            # successful boundary.  Any completed compaction is a boundary.
            boundary = connection.execute("SELECT seq FROM session_message WHERE session_id=? AND type='compaction' AND json_extract(data,'$.status')='completed' ORDER BY seq DESC LIMIT 1", (row[0],)).fetchone()
            query = "SELECT id,data FROM session_message WHERE session_id=? AND type='assistant'"
            params: list[object] = [row[0]]
            if boundary:
                query += " AND seq>?"
                params.append(boundary[0])
            query += " ORDER BY seq DESC LIMIT 64"
            for assistant_id, assistant_data in connection.execute(query, params):
                observation = _completed_context_observation(assistant_data, assistant_id)
                if observation is not None:
                    completed, context_tokens = observation
                    item["contextTokens"] = context_tokens
                    item["contextObservedAt"] = completed
                    item["contextMessageID"] = assistant_id
                    break
            rows.append(item)
        return rows


_NATIVE_RECOVERY_TEXT = "The previous response was interrupted. Continue from where you left off without repeating completed content."


def _native_timestamp(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= 9007199254740991


def _assistant_identity(item):
    model, agent = item.get("model"), item.get("agent")
    if not isinstance(agent, str) or not agent or not isinstance(model, dict):
        return None
    if any(not isinstance(model.get(key), str) or not model[key] for key in ("providerID", "id")):
        return None
    if "variant" in model and (not isinstance(model["variant"], str) or not model["variant"]):
        return None
    return agent, model["providerID"], model["id"], model.get("variant")


def _native_recovery(item, message_id):
    """Require retained native RetryScheduled evidence, never error text alone."""
    error, retry = item.get("error"), item.get("retry")
    completed = (item.get("time") or {}).get("completed")
    if item.get("finish") != "error" or not isinstance(error, dict) or not isinstance(retry, dict):
        return None
    if error.get("type") not in ("provider.internal", "provider.transport") or retry.get("error") != error:
        return None
    status = error.get("status")
    if status is not None and (not isinstance(status, int) or isinstance(status, bool) or not 500 <= status < 600):
        return None
    attempt, at = retry.get("attempt"), retry.get("at")
    if not isinstance(attempt, int) or isinstance(attempt, bool) or not 2 <= attempt <= 1000000:
        return None
    if not _native_timestamp(completed) or not _native_timestamp(at) or at < completed or not _assistant_identity(item):
        return None
    return {"errorID":str(message_id), "type":error["type"], "attempt":attempt}


def completion_receipt(session_id: str, marker: str, prompt_hash: str, *, db_path: str | Path | None = None) -> dict[str, object] | None:
    """Return only a terminal chain bound to one exact dispatched prompt."""
    accepted = set(prompt_hash.split(","))
    with _connect(db_path) as connection:
        connection.execute("BEGIN")
        columns = {r[1] for r in connection.execute("pragma table_info(session_v2)")}
        if "idle_outcome" not in columns:
            return None
        # A queued prompt is not a finished generation, regardless of any older idle.
        pending = connection.execute("SELECT 1 FROM session_inbox WHERE session_id=? AND delivery!='delivered' LIMIT 1", (session_id,)).fetchone()
        if pending:
            return None
        candidates = []
        for ident, payload in connection.execute("SELECT id,payload FROM session_inbox WHERE session_id=?", (session_id,)):
            try: text = json.loads(payload).get("text")
            except (TypeError, json.JSONDecodeError): text = None
            if isinstance(text, str) and marker in text and hashlib.sha256(text.encode()).hexdigest() in accepted:
                candidates.append((str(ident), None))
        for ident, seq, data in connection.execute("SELECT id,seq,data FROM session_message WHERE session_id=? AND type='user' ORDER BY seq", (session_id,)):
            try: text = json.loads(data).get("text")
            except (TypeError, json.JSONDecodeError): text = None
            if isinstance(text, str) and marker in text and hashlib.sha256(text.encode()).hexdigest() in accepted:
                candidates.append((str(ident), int(seq)))
        ids = {item[0] for item in candidates}
        bound = [item for item in candidates if item[1] is not None]
        if len(ids) != 1 or len(bound) != 1:
            return None
        prompt_id, prompt_seq = bound[0]
        after = list(connection.execute("SELECT id,seq,type,data FROM session_message WHERE session_id=? AND seq>? ORDER BY seq", (session_id, prompt_seq)))
        assistant = None
        receipt = None
        recoveries, pending_recovery, recovered_identity = [], None, None
        for ident, seq, kind, data in after:
            # The terminal answer must immediately precede one successful idle,
            # with no later message that could extend or supersede this result.
            if receipt is not None or (assistant is not None and kind != "idle"):
                return None
            if kind in ("user", "compaction", "model-switched", "agent-switched", "location-switched"):
                return None
            if pending_recovery is not None:
                # Continue emits this exact next projected row only after the
                # native retry decision retained on the failed assistant.
                if kind != "synthetic": return None
                try: recovery = json.loads(data)
                except (TypeError, json.JSONDecodeError): return None
                if not isinstance(recovery, dict) or recovery.get("text") != _NATIVE_RECOVERY_TEXT: return None
                recoveries.append({**pending_recovery, "recoveryID":str(ident)})
                pending_recovery = None
                continue
            if kind == "assistant":
                if receipt is not None or assistant is not None: return None
                try: item = json.loads(data)
                except (TypeError, json.JSONDecodeError): return None
                content = item.get("content")
                text = "".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text") if isinstance(content, list) else ""
                finish=item.get("finish")
                completed=(item.get("time") or {}).get("completed")
                if not isinstance(completed, (int, float)) or isinstance(completed, bool) or not math.isfinite(completed) or completed <= 0:
                    return None
                if recovered_identity is not None and _assistant_identity(item) != recovered_identity:
                    return None
                if item.get("error") or finish in ("error", "cancelled", "aborted"):
                    pending_recovery = _native_recovery(item, ident)
                    if pending_recovery is None or len(recoveries) >= 8: return None
                    recovered_identity = _assistant_identity(item)
                    continue
                if finish == "stop":
                    if receipt is not None or not text.strip(): return None
                    assistant = (str(ident), int(seq))
                elif finish not in ("tool-calls", "tool_calls", None):
                    return None
            elif kind == "idle":
                if assistant is None: return None
                try:
                    idle = json.loads(data)
                    outcome = idle.get("outcome")
                except (TypeError, json.JSONDecodeError): return None
                if outcome != "succeeded": return None
                receipt = {"promptID": prompt_id, "assistantID": assistant[0], "assistantSeq": assistant[1], "idleID": str(ident), "idleSeq": int(seq)}
                timing = idle.get("time")
                completed_at = timing.get("created") if isinstance(timing, dict) else None
                if isinstance(completed_at, int) and not isinstance(completed_at, bool) and 0 < completed_at <= 9007199254740991:
                    receipt["completedAt"] = completed_at
                if recoveries:
                    receipt["recoveredProviderErrors"] = recoveries
        return None if pending_recovery is not None else receipt


def _terminal_prompt(connection, session_id: str, marker: str, prompt_hash: str):
    accepted = {value for value in prompt_hash.split(",") if value}
    if not accepted:
        return None
    candidates = []
    try:
        inbox_rows = connection.execute("SELECT id,payload FROM session_inbox WHERE session_id=?", (session_id,))
        for ident, payload in inbox_rows:
            try:
                item = json.loads(payload)
                text = item.get("text") if isinstance(item, dict) else None
            except (TypeError, json.JSONDecodeError):
                text = None
            if isinstance(text, str) and marker in text and hashlib.sha256(text.encode()).hexdigest() in accepted:
                candidates.append((str(ident), None))
    except sqlite3.OperationalError:
        return None
    for ident, seq, data in connection.execute(
        "SELECT id,seq,data FROM session_message WHERE session_id=? AND type='user' ORDER BY seq", (session_id,)
    ):
        try:
            item = json.loads(data)
            text = item.get("text") if isinstance(item, dict) else None
        except (TypeError, json.JSONDecodeError):
            text = None
        if isinstance(text, str) and marker in text and hashlib.sha256(text.encode()).hexdigest() in accepted:
            candidates.append((str(ident), int(seq)))
    ids = {ident for ident, _ in candidates}
    bound = [candidate for candidate in candidates if candidate[1] is not None]
    if len(ids) != 1 or len(bound) != 1:
        return None
    return bound[0]


def terminal_receipt(session_id: str, marker: str, prompt_hash: str, *, db_path: str | Path | None = None) -> dict[str, object] | None:
    """Return a sanitized native terminal outcome for one exact prompt generation."""
    with _connect(db_path) as connection:
        connection.execute("BEGIN")
        columns = {row[1] for row in connection.execute("pragma table_info(session_v2)")}
        if "idle_outcome" not in columns or "time_suspended" not in columns:
            return None
        session_columns = ["time_suspended"]
        if "time_compacting" in columns:
            session_columns.append("time_compacting")
        row = connection.execute(
            "SELECT idle_outcome," + ",".join(session_columns) + " FROM session_v2 WHERE id=?", (session_id,)
        ).fetchone()
        if row is None or row[0] not in ("succeeded", "failed", "interrupted") or row[1] is not None or (len(row) > 2 and row[2] is not None):
            return None
        try:
            pending = connection.execute(
                "SELECT 1 FROM session_inbox WHERE session_id=? AND delivery!='delivered' LIMIT 1", (session_id,)
            ).fetchone()
        except sqlite3.OperationalError:
            return None
        if pending:
            return None
        prompt = _terminal_prompt(connection, session_id, marker, prompt_hash)
        if prompt is None:
            return None
        prompt_id, prompt_seq = prompt
        rows = connection.execute(
            "SELECT id,seq,type,data FROM session_message WHERE session_id=? AND seq>? ORDER BY seq",
            (session_id, prompt_seq),
        )
        assistant = None
        assistant_outcome = None
        terminal_assistant = False
        pending_recovery = None
        recoveries = 0
        recovered_identity = None
        terminal_idle = None
        terminal_idle_data = None
        for ident, seq, kind, data in rows:
            if terminal_idle is not None:
                return None
            if kind in ("user", "compaction", "model-switched", "agent-switched", "location-switched"):
                return None
            try:
                item = json.loads(data)
            except (TypeError, json.JSONDecodeError):
                return None
            if not isinstance(item, dict):
                return None
            if terminal_assistant and kind != "idle":
                return None
            if pending_recovery is not None:
                if kind != "synthetic":
                    return None
                if item.get("text") != _NATIVE_RECOVERY_TEXT:
                    return None
                pending_recovery = None
                continue
            if kind == "assistant":
                if assistant is not None:
                    return None
                if recovered_identity is not None and _assistant_identity(item) != recovered_identity:
                    return None
                finish = item.get("finish")
                timing = item.get("time")
                completed = timing.get("completed") if isinstance(timing, dict) else None
                if "error" in item and item["error"] is not None and not isinstance(item["error"], dict):
                    return None
                if item.get("error") or finish in ("error", "cancelled", "aborted"):
                    if not _native_timestamp(completed):
                        return None
                    if item.get("error") or finish == "error":
                        recovery = _native_recovery(item, ident)
                        if recovery is not None:
                            if recoveries >= 8:
                                return None
                            pending_recovery = recovery
                            recoveries += 1
                            recovered_identity = _assistant_identity(item)
                            assistant = None
                            assistant_outcome = None
                            continue
                        if "retry" in item:
                            return None
                    assistant = (str(ident), int(seq), completed)
                    assistant_outcome = "failed" if item.get("error") or finish == "error" else "interrupted"
                    terminal_assistant = True
                elif finish == "stop":
                    if not _native_timestamp(completed):
                        return None
                    content = item.get("content")
                    text = "".join(part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text") if isinstance(content, list) else ""
                    if not text.strip():
                        return None
                    assistant = (str(ident), int(seq), completed)
                    assistant_outcome = "succeeded"
                    terminal_assistant = True
                elif finish in ("tool-calls", "tool_calls", None):
                    continue
                else:
                    return None
            elif kind == "idle":
                outcome = item.get("outcome")
                if outcome not in ("succeeded", "failed", "interrupted"):
                    return None
                if outcome != row[0]:
                    return None
                if terminal_idle is not None:
                    return None
                if outcome == "succeeded" and (assistant is None or assistant_outcome != "succeeded"):
                    return None
                if assistant_outcome == "failed" and outcome != "failed":
                    return None
                if assistant_outcome == "interrupted" and outcome not in ("interrupted", "failed"):
                    return None
                terminal_idle = (str(ident), int(seq), outcome)
                terminal_idle_data = item
            else:
                # Other rows are only acceptable before the terminal idle and
                # carry no completion evidence themselves.
                continue
        if terminal_idle is None:
            return None
        outcome = terminal_idle[2]
        receipt = {"promptID": prompt_id, "idleID": terminal_idle[0], "idleSeq": terminal_idle[1], "outcome": outcome}
        if assistant is not None:
            receipt.update({"assistantID": assistant[0], "assistantSeq": assistant[1]})
        timing = terminal_idle_data.get("time") if isinstance(terminal_idle_data, dict) else None
        completed_at = timing.get("created") if isinstance(timing, dict) else None
        if _native_timestamp(completed_at):
            receipt["completedAt"] = completed_at
        return receipt



def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 2 and args[0] == "--intent-sources":
        print(json.dumps(intent_sources(args[1])))
        return 0
    if len(args) == 4 and args[0] == "--completion-receipt":
        print(json.dumps(completion_receipt(args[1], args[2], args[3])))
        return 0
    if len(args) == 4 and args[0] == "--terminal-receipt":
        print(json.dumps(terminal_receipt(args[1], args[2], args[3])))
        return 0
    print(json.dumps(sessions()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

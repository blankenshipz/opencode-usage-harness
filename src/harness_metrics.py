"""Read-only progress and efficiency metrics for the v2 harness.

The collector deliberately reports execution evidence separately from task
acceptance.  It never reads tool output files and never includes message text.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

try:
    from .paths import opencode_db, ownership_dir as ownership_dir_path, state_dir
except ImportError:  # direct execution via bin/harness-metrics
    from paths import opencode_db, ownership_dir as ownership_dir_path, state_dir
try:
    from .timing_metrics import collect_timing, read_timing_events
except ImportError:  # direct execution via bin/harness-metrics
    from timing_metrics import collect_timing, read_timing_events


try:
    from .compression_metrics import compression_metrics
except ImportError:
    from compression_metrics import compression_metrics


try:
    from .cache_drift_metrics import cache_drift_metrics
except ImportError:
    from cache_drift_metrics import cache_drift_metrics


def _json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _num(value: Any) -> int:
    return int(value or 0) if isinstance(value, (int, float)) else 0


def _tool_status(state: dict[str, Any]) -> str:
    status = str(state.get("status", "")).lower()
    if status in {"completed", "success", "succeeded"}:
        return "succeeded"
    if status in {"running", "pending", "started", "in_progress", "streaming"}:
        return "outstanding"
    error = state.get("error")
    error_type = error.get("type") if isinstance(error, dict) else str(error or "").lower()
    if status in {"interrupted", "cancelled", "canceled", "aborted"} or "abort" in str(error_type).lower():
        return "interrupted"
    return "failed"


def _iter_tools(data: dict[str, Any]):
    content = data.get("content")
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool":
                yield item
    if data.get("type") == "tool":
        yield data


def _accepted(ownership_dir: Path, root_id: str) -> list[dict[str, Any]]:
    result = []
    if not ownership_dir.exists():
        return result
    for path in sorted(ownership_dir.glob("*.json")):
        try:
            doc = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        intents = doc.get("intents") or {}
        evidence = doc.get("intentEvidence") or {}
        for key, intent_record in intents.items():
            if not isinstance(intent_record, dict) or intent_record.get("rootID") != root_id:
                continue
            ev = evidence.get(key) if isinstance(evidence, dict) else None
            revision = intent_record.get("revision")
            checks = ev.get("checks") if isinstance(ev, dict) else None
            intent_checks = (intent_record.get("intent") or {}).get("checks") or []
            expected = {str(c.get("id")): c.get("mode") for c in intent_checks if isinstance(c, dict) and c.get("id")}
            reliable = (
                isinstance(ev, dict)
                and ev.get("revision") == revision
                and isinstance(checks, dict)
                and bool(expected)
                and set(checks) == set(expected)
                and all(isinstance(checks.get(k), dict) and checks[k].get("status") == "passed" and checks[k].get("mode") == mode for k, mode in expected.items())
                and ev.get("lastStatus") == "completed"
                and ev.get("lastScope") == "task"
                and not any(c.get("artifact") for c in intent_checks if isinstance(c, dict))
            )
            result.append({
                "task_id": intent_record.get("taskId"),
                "revision": revision,
                "status": "self_reported_complete" if reliable else "unknown",
                "checks": {str(k): (v.get("status") if isinstance(v, dict) else "unknown") for k, v in (checks or {}).items()},
                "self_reported": True,
                "required_checks": len(expected),
                "passed_checks": sum(isinstance(checks, dict) and isinstance(checks.get(k), dict) and checks[k].get("status") == "passed" and checks[k].get("mode") == mode for k, mode in expected.items()) if isinstance(ev, dict) and ev.get("revision") == revision else 0,
                "gap": None if reliable else "completion unverified: missing/mismatched current checks, incomplete task status, or artifact freshness not verified",
            })
    return result


def collect_metrics(db_path: str | Path | None = None, *, days: int = 7,
                    session_id: str | None = None,
                    ownership_dir: str | Path | None = None,
                    now_ms: int | None = None) -> dict[str, Any]:
    """Collect metrics from SQLite in read-only mode."""
    db_path = opencode_db() if db_path is None else Path(db_path)
    ownership_dir = ownership_dir if ownership_dir is not None else ownership_dir_path()
    now_ms = int(now_ms if now_ms is not None else time.time() * 1000)
    cutoff = now_ms - max(0, days) * 86400000
    uri = f"file:{Path(db_path).resolve()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        table = "session_v2"
        if not conn.execute("select 1 from sqlite_master where type='table' and name='session_v2'").fetchone():
            raise ValueError("v2 schema requires session_v2")
        cols = {r[1] for r in conn.execute(f"pragma table_info({table})")}
        parent = "parent_id" if "parent_id" in cols else "parentID"
        created = "time_created" if "time_created" in cols else "timeCreated"
        rows = conn.execute(f"select id, {parent} as parent_id, {created} as time_created, time_updated from {table}").fetchall()
        by_id = {r["id"]: dict(r) for r in rows}
        if session_id and session_id not in by_id:
            raise ValueError(f"session not found: {session_id}")
        recent = {r["id"] for r in rows if max(_num(r["time_created"]), _num(r["time_updated"])) >= cutoff}
        recent.update(r[0] for r in conn.execute("select distinct session_id from session_message where time_created >= ?", (cutoff,)))
        root_ids = set()
        for sid in recent:
            seen = set()
            while sid in by_id and by_id[sid]["parent_id"] and sid not in seen:
                seen.add(sid)
                sid = by_id[sid]["parent_id"]
            if sid in by_id and not by_id[sid]["parent_id"]:
                root_ids.add(sid)
        roots = [session_id] if session_id else sorted(root_ids)
        selected: dict[str, list[str]] = {}
        for root in roots:
            ids = []
            pending = [root]
            while pending:
                current = pending.pop()
                if current in ids:
                    continue
                row = by_id.get(current)
                if not row:
                    continue
                ids.append(current)
                pending.extend(r["id"] for r in rows if r["parent_id"] == current)
            selected[root] = ids

        message_table = "session_message" if table == "session_v2" else "message"
        message_cols = {r[1] for r in conn.execute(f"pragma table_info({message_table})")}
        data_col = "data"
        messages_by_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
        if selected:
            placeholders = ",".join("?" for _ in by_id)
            for row in conn.execute(f"select id, session_id, type, time_created, {data_col} as data from {message_table} where session_id in ({placeholders}) and time_created >= ?", tuple(by_id) + (cutoff,)):
                parsed = _json(row["data"])
                parsed["_message_type"] = row["type"]
                parsed["_message_id"] = row["id"]
                messages_by_session[row["session_id"]].append(parsed)

        timing_path = state_dir() / "telemetry" / "execution-timing.jsonl"
        timing_events, timing_error = read_timing_events(timing_path)
        reports = []
        for root, ids in selected.items():
            tokens = Counter()
            models = Counter()
            tools = Counter(succeeded=0, interrupted=0, failed=0, outstanding=0)
            errors = retries = 0
            outstanding = []
            native_timing = []
            for sid in ids:
                for msg in messages_by_session.get(sid, []):
                    if msg.get("_message_type") != "assistant":
                        continue
                    model = msg.get("model") or msg.get("modelID") or {}
                    if isinstance(model, dict):
                        model = f"{model.get('id') or 'unknown'}#{model.get('variant') or 'unspecified'}"
                    role = msg.get("agent") or msg.get("mode") or msg.get("role") or msg.get("_message_type") or "unknown"
                    models[f"{model}/{role}"] += 1
                    t = msg.get("tokens") or {}
                    tokens["input"] += _num(t.get("input"))
                    tokens["output"] += _num(t.get("output"))
                    tokens["reasoning"] += _num(t.get("reasoning"))
                    cache = t.get("cache") or {}
                    tokens["cache_read"] += _num(cache.get("read"))
                    tokens["cache_write"] += _num(cache.get("write"))
                    if msg.get("retry") is not None:
                        retries += _num(msg.get("retry")) if isinstance(msg.get("retry"), (int, float)) else (1 if msg.get("retry") else 0)
                    for tool in _iter_tools(msg):
                        state = tool.get("state") or {}
                        status = _tool_status(state)
                        tools[status] += 1
                        if status == "failed":
                            errors += 1
                        if status == "outstanding":
                            started = (tool.get("time") or {}).get("created")
                            outstanding.append({"tool": str(tool.get("name") or "unknown"), "duration_ms": max(0, now_ms - _num(started)) if started else None, "label": "outstanding"})
                        # Native DB timing is only a fallback for explicitly
                        # classified tool intervals.  Command text is never
                        # inspected to guess whether a tool was a test.
                        if tool.get("executed") is True:
                            continue  # Provider-hosted execution is not native runtime work.
                        tool_name = str(tool.get("name") or "").lower()
                        if tool_name in {"execute", "subagent"}:
                            timing_category = "delegation_wait_review"
                        elif tool_name in {"shell", "native", "native_tool"}:
                            timing_category = "native_tool"
                        else:
                            timing_category = "native_tool"
                        timing = tool.get("timing") if isinstance(tool.get("timing"), dict) else tool.get("time")
                        if isinstance(timing_category, str) and isinstance(timing, dict):
                            # `created` precedes native execution and includes
                            # model tool-input generation; only ran->completed
                            # is attributable to the native operation.
                            started = timing.get("start_ms") or timing.get("ran")
                            ended = timing.get("end_ms") or timing.get("completed")
                            if isinstance(started, (int, float)) and isinstance(ended, (int, float)):
                                native_timing.append({"session_id": sid, "messageId": msg.get("_message_id"), "toolId": tool.get("id"), "category": timing_category, "interval_id": f"{sid}:{msg.get('_message_id') or ''}:{tool.get('id') or tool.get('name') or started}", "start_ms": int(started), "end_ms": int(ended)})
            acceptance = _accepted(Path(ownership_dir), root)
            timing = collect_timing(timing_path, session_ids=set(ids), start_ms=cutoff, end_ms=now_ms, fallback_intervals=native_timing, events=timing_events, read_error=timing_error)
            reports.append({"root_session": root, "sessions": len(ids), "models_roles": dict(models), "tokens": {"uncached_input": tokens["input"], "output": tokens["output"], "reasoning": tokens["reasoning"], "cache_read": tokens["cache_read"], "cache_write": tokens["cache_write"]}, "tool_calls": dict(tools), "tool_errors": errors, "tool_retries": retries, "outstanding_tools": outstanding, "timing": timing, "context_compression": compression_metrics(state_dir() / "tool-output-store", session_ids=set(ids), cutoff_ms=cutoff, now_ms=now_ms), "cache_drift": cache_drift_metrics(state_dir() / "telemetry" / "cache-drift.jsonl", session_ids=set(ids), cutoff_ms=cutoff, now_ms=now_ms), "blocked_minutes": None, "acceptance": acceptance or [{"status": "unknown", "gap": "no reliable intent evidence"}], "workload_label": "self-reported completion; usage is per root workload" if acceptance and all(x["status"] == "self_reported_complete" for x in acceptance) else "per-root workload"})
        return {"days": days, "cutoff_ms": cutoff, "reports": reports}
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read-only harness progress metrics")
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--session")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = collect_metrics(days=args.days, session_id=args.session)
    if args.json:
        print(json.dumps(result, sort_keys=True))
        return 0
    print(f"Harness progress ({result['days']} days): {len(result['reports'])} root workload(s)")
    for report in result["reports"]:
        t = report["tokens"]
        print(f"- {report['root_session']}: {report['workload_label']}; sessions={report['sessions']}; models/roles={report['models_roles']}; tokens uncached-input={t['uncached_input']} output={t['output']} reasoning={t['reasoning']} cache-read={t['cache_read']} cache-write={t['cache_write']}; tool-calls={report['tool_calls']}; tool-errors={report['tool_errors']} observed-retries={report['tool_retries']}; blocked-minutes=unknown")
        for task in report["acceptance"]:
            print(f"  task={task.get('task_id', 'unknown')} checks={task.get('passed_checks', 0)}/{task.get('required_checks', '?')} status={task['status']}")
        for tool in report["outstanding_tools"]:
            print(f"  outstanding {tool['tool']} age-ms={tool['duration_ms']} (not proven blocked)")
        compression = report["context_compression"]
        print(f"  context compression: prepared={compression['prepared_results']} reduced-chars={compression['reduced_chars']} (not token/credit savings)")
        print(f"  compression diagnostics: status={compression.get('diagnostics_status', 'unavailable')} skipped={compression.get('skipped_reasons', {})}; original-reads={compression.get('native_original_retrievals', 0)}; overhead={compression.get('processing_overhead_ms', {})}; tokens={compression.get('token_estimate', {})}")
        drift = report['cache_drift']
        print(f"  cache observation: status={drift['status']} reasons={drift['reasons']} changed={drift['changed_dimensions']} (not proven cache misses)")
        timing = report.get("timing", {})
        overall = timing.get("overall", {})
        print(f"  timing source={timing.get('source', 'unavailable')} overall-ms={overall.get('duration_ms', 'unknown')} status={overall.get('status', 'unknown')}")
        categories = timing.get("categories", {})
        if categories:
            summary = ", ".join(f"{name}={item.get('duration_ms') if item.get('duration_ms') is not None else 'unknown'}ms" for name, item in categories.items())
            print(f"  timing categories: {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

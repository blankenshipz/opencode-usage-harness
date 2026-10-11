"""Read-only elapsed-time attribution from bounded execution telemetry.

Timing is evidence, not a reconstruction of time spent between events.  Only
explicit start/end pairs are measured; open and unmatched records remain
visible as coverage gaps.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable


CATEGORIES = (
    "provider_request",
    "model_request",
    "native_tool",
    "human_approval",
    "form_wait",
    "delegation_wait_review",
    "throttling",
)

_ALIASES = {
    "provider": "provider_request", "provider_request_latency": "provider_request",
    "request": "provider_request", "inference": "provider_request", "model": "model_request",
    "tool": "native_tool", "shell": "native_tool", "test": "native_tool",
    "tool_shell_test": "native_tool", "tool_shell": "native_tool", "tool_test": "native_tool",
    "approval": "human_approval", "human_approval_wait": "human_approval",
    "permission": "human_approval", "form": "form_wait",
    "delegation": "delegation_wait_review", "delegation_wait": "delegation_wait_review", "review": "delegation_wait_review",
    "throttle": "throttling", "rate_limit": "throttling",
}


def _number(value: Any) -> int | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return int(value)
    return None


def _event_data(event: dict[str, Any]) -> dict[str, Any]:
    data = event.get("data")
    return data if isinstance(data, dict) else event


def _category(data: dict[str, Any]) -> str | None:
    value = data.get("category") or data.get("kind") or data.get("phase")
    if not isinstance(value, str):
        return None
    key = value.strip().lower().replace("-", "_").replace(" ", "_")
    if key in CATEGORIES:
        return key
    return _ALIASES.get(key)


def _session(data: dict[str, Any]) -> str | None:
    for key in ("session_id", "sessionID", "sessionId", "root_session", "rootSession"):
        if isinstance(data.get(key), str):
            return data[key]
    return None


def _timestamp(data: dict[str, Any], *keys: str) -> int | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, dict):
            value = value.get("ms") or value.get("timestamp") or value.get("at")
        number = _number(value)
        if number is not None:
            return number
    return None


def _event_type(event: dict[str, Any], data: dict[str, Any]) -> str:
    value = event.get("type") or data.get("event") or data.get("action") or data.get("state")
    return str(value or "").lower().replace(".", "_").replace("-", "_")


def _id(data: dict[str, Any]) -> str | None:
    for key in ("interval_id", "intervalId", "operation_id", "operationId", "request_id", "requestId", "id"):
        if isinstance(data.get(key), (str, int)):
            return str(data[key])
    return None


def _identity(data: dict[str, Any], category: str) -> str | None:
    """Return a session/step scoped ID from the observer's closed schema."""
    session = _session(data) or ""
    if category == "model_request":
        value = data.get("messageId") or data.get("assistantMessageID") or data.get("message_id")
    elif category == "native_tool":
        tool = data.get('toolId') or data.get('id')
        value = f"{data.get('messageId') or data.get('assistantMessageID') or ''}:{tool}" if tool else _id(data)
    elif category == "human_approval":
        value = data.get("requestId") or data.get("request_id") or data.get("id")
    elif category == "form_wait":
        value = data.get("formId") or data.get("form_id") or data.get("id")
    else:
        value = _id(data)
    return f"{session}:{value}" if value not in (None, "") else None


def _interval_key(category, ident, begin, finish):
    # A native call ID names one operation in both the stream and DB projection.
    # A model message may have several request attempts, so retain its boundaries.
    return (category, ident) if category == "native_tool" and ident else (category, ident, begin, finish)


def _union(intervals: Iterable[tuple[int, int]]) -> int:
    ordered = sorted((a, b) for a, b in intervals if b > a)
    total = 0
    start = end = None
    for a, b in ordered:
        if start is None:
            start, end = a, b
        elif a <= end:
            end = max(end, b)
        else:
            total += end - start
            start, end = a, b
    return total + (end - start if start is not None else 0)


def _blank(status: str = "unknown") -> dict[str, Any]:
    return {"duration_ms": None, "intervals": 0, "open": 0, "unmatched": 0, "status": status}


def _read_jsonl(path: Path) -> tuple[list[dict[str, Any]], str | None]:
    if not path.exists():
        return [], "collection_unavailable"
    events = []
    try:
        with path.open() as stream:
            for line in stream:
                try:
                    value = json.loads(line)
                except (json.JSONDecodeError, TypeError):
                    continue
                if isinstance(value, dict):
                    events.append(value)
    except OSError:
        return [], "collection_unavailable"
    return events, None


def read_timing_events(path: str | Path) -> tuple[list[dict[str, Any]], str | None]:
    """Read the telemetry source once for callers with many roots."""
    return _read_jsonl(Path(path))


def collect_timing(path: str | Path, *, session_ids: set[str] | None = None,
                   start_ms: int | None = None, end_ms: int | None = None,
                   fallback_intervals: Iterable[dict[str, Any]] | None = None,
                   events: list[dict[str, Any]] | None = None,
                   read_error: str | None = None) -> dict[str, Any]:
    """Collect timing for selected sessions and a bounded interval window."""
    path = Path(path)
    fallback = list(fallback_intervals or []) if fallback_intervals is not None else None
    if events is None:
        events, unavailable = _read_jsonl(path)
    else:
        unavailable = read_error
    source = "telemetry_and_native_db" if unavailable is None and fallback else "telemetry" if unavailable is None else "native_db_fallback" if fallback else "unavailable"
    if unavailable is not None and not fallback:
        categories = {name: _blank() for name in CATEGORIES}
        return {"source": source, "available": False, "window_ms": {"start": start_ms, "end": end_ms}, "categories": categories, "overall": _blank(), "diagnostics": {"droppedTelemetry": 0, "rateLimited": 0, "serviceWideLoss": 0}, "coverage": {"limitations": [unavailable], "interval_window": {"start_ms": start_ms, "end_ms": end_ms}}}

    records: list[dict[str, Any]] = []
    diagnostics_records = []
    event_keys = set()
    if unavailable is None:
        for event in events:
            data = _event_data(event)
            event_key = data.get("eventId") or json.dumps(data, sort_keys=True)
            if event_key in event_keys:
                continue
            event_keys.add(event_key)
            observed = _timestamp(data, "observedAt", "observed_at", "timestamp_ms")
            if (start_ms is None or observed is None or observed >= start_ms) and (end_ms is None or observed is None or observed <= end_ms):
                diagnostics_records.append(data)
            if session_ids and _session(data) not in session_ids:
                continue
            category = _category(data)
            if category:
                records.append({"event": event, "data": data, "category": category})
    records.extend({"event": x, "data": x, "category": _category(x)} for x in (fallback or []) if _category(x) and (not session_ids or _session(x) in session_ids))

    open_count = defaultdict(int)
    unmatched = defaultdict(int)
    pairs: dict[tuple[str, str], tuple[int, dict[str, Any]]] = {}
    intervals: dict[str, list[tuple[int, int]]] = defaultdict(list)
    seen = set()
    dropped_telemetry = 0
    rate_limited = 0
    service_wide_loss = 0
    for data in diagnostics_records:
        dropped_telemetry += int(data.get("droppedTelemetry") or 0) if isinstance(data.get("droppedTelemetry"), (int, float)) else 0
        rate_limited += 1 if data.get("rateLimited") is True and (not session_ids or _session(data) in session_ids) else 0
        if data.get("droppedTelemetry"):
            service_wide_loss += int(data["droppedTelemetry"])
    for record in records:
        data, category = record["data"], record["category"]
        event_type = _event_type(record["event"], data)
        ident = _identity(data, category)
        if ident is None and _id(data) is not None:
            ident = f"{_session(data) or ''}:{_id(data)}"
        begin = _timestamp(data, "start_ms", "startMs", "started_ms", "startedAt", "start", "created", "timestamp_ms", "timestamp", "at_ms", "atMs")
        finish = _timestamp(data, "end_ms", "endMs", "ended_ms", "endedAt", "end", "completed", "finished", "stopped")
        if begin is not None and finish is not None:
            pair = (max(begin, start_ms) if start_ms is not None else begin, min(finish, end_ms) if end_ms is not None else finish)
            if pair[1] > pair[0]:
                key = _interval_key(category, ident, begin, finish)
                if key not in seen:
                    seen.add(key); intervals[category].append(pair)
            if ident is not None:
                pairs.pop((category, ident), None)
            continue
        is_start = any(word in event_type for word in ("start", "started", "open", "requested", "created", "asked", "called"))
        is_end = any(word in event_type for word in ("end", "ended", "complete", "finish", "stop", "resolved", "replied", "cancelled", "success", "failed", "streamed"))
        if begin is None and is_start:
            begin = _timestamp(data, "observedAt", "observed_at")
        if finish is None and is_end:
            finish = _timestamp(data, "observedAt", "observed_at")
        if (end_ms is not None and begin is not None and begin > end_ms) or (start_ms is not None and finish is not None and finish < start_ms):
            continue
        if ident is None or begin is None and finish is None:
            unmatched[category] += 1
        elif is_start and begin is not None:
            if (category, ident) in pairs and any(word in event_type for word in ("restart", "retry")):
                # A restarted operation leaves the earlier attempt open; keep
                # that evidence visible instead of treating it as elapsed.
                open_count[category] += 1
            pairs[(category, ident)] = (begin, data)
        elif is_end and finish is not None:
            prior = pairs.pop((category, ident), None)
            if prior is None:
                unmatched[category] += 1
            else:
                a = max(prior[0], start_ms) if start_ms is not None else prior[0]
                b = min(finish, end_ms) if end_ms is not None else finish
                key = _interval_key(category, ident, prior[0], finish)
                if b > a and key not in seen:
                    seen.add(key); intervals[category].append((a, b))
        else:
            unmatched[category] += 1
    for (category, _ident), (started, _data) in pairs.items():
        if start_ms is not None and started < start_ms:
            unmatched[category] += 1
        else:
            open_count[category] += 1

    categories = {}
    for category in CATEGORIES:
        if intervals[category]:
            categories[category] = {"duration_ms": _union(intervals[category]), "intervals": len(intervals[category]), "open": open_count[category], "unmatched": unmatched[category], "status": "observed"}
        else:
            result = _blank("unknown")
            result.update({"open": open_count[category], "unmatched": unmatched[category]})
            if open_count[category] or unmatched[category]: result["status"] = "incomplete"
            categories[category] = result
    all_intervals = [item for values in intervals.values() for item in values]
    overall = {"duration_ms": _union(all_intervals) if all_intervals else None, "intervals": len(all_intervals), "open": sum(open_count.values()), "unmatched": sum(unmatched.values()), "status": "observed" if all_intervals else "unknown"}
    limitations = []
    if any(x["open"] or x["unmatched"] for x in categories.values()): limitations.append("some timing records lack a matching start or end")
    if not records: limitations.append("no matching timing records")
    if dropped_telemetry:
        limitations.append("telemetry records were dropped by the observer; loss is service-wide and cannot be attributed to this root")
    return {"source": source, "available": True, "window_ms": {"start": start_ms, "end": end_ms}, "categories": categories, "overall": overall, "diagnostics": {"droppedTelemetry": dropped_telemetry, "rateLimited": rate_limited, "serviceWideLoss": service_wide_loss}, "coverage": {"limitations": limitations, "interval_window": {"start_ms": start_ms, "end_ms": end_ms}}}

"""Offline, provider-neutral planning for subscription task pools.

The module deliberately consumes normalized fixture data.  It does not inspect
credentials, contact providers, reserve capacity, or execute tasks.
"""
from __future__ import annotations

import math
import time
from typing import Any, Mapping, Sequence


class PoolValidationError(ValueError):
    """Raised when a pool configuration or snapshot has an invalid shape."""


TIERS = ("FAST", "BALANCED", "STRONG", "MAXIMUM")


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise PoolValidationError(f"{field} must be a finite number")
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise PoolValidationError(f"{field} must be a finite number") from None
    if not math.isfinite(number):
        raise PoolValidationError(f"{field} must be a finite number")
    return number


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise PoolValidationError(f"{field} must be a positive integer")
    return value


def _routes(value: Any, field: str) -> dict[str, dict[str, str]]:
    if not isinstance(value, Mapping) or not value:
        raise PoolValidationError(f"{field} must be a non-empty tier mapping")
    result: dict[str, dict[str, str]] = {}
    for tier, route in value.items():
        if tier not in TIERS or not isinstance(route, Mapping):
            raise PoolValidationError(f"{field} must map tier names to routes")
        model, effort = route.get("model"), route.get("effort")
        if not isinstance(model, str) or not model or not isinstance(effort, str) or not effort:
            raise PoolValidationError(f"{field}.{tier} requires model and effort")
        result[tier] = {"model": model, "effort": effort}
    return {tier: result[tier] for tier in TIERS if tier in result}


def validate_pool_configs(configs: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Validate and normalize pool configurations in their supplied order."""
    if isinstance(configs, (str, bytes)) or not isinstance(configs, Sequence):
        raise PoolValidationError("pools must be a sequence")
    result: list[dict[str, Any]] = []
    ids: set[str] = set()
    for index, config in enumerate(configs):
        if not isinstance(config, Mapping):
            raise PoolValidationError(f"pools[{index}] must be an object")
        ident = config.get("id")
        for field in ("id", "provider", "quota_group", "adapter"):
            if not isinstance(config.get(field), str) or not config[field]:
                raise PoolValidationError(f"pools[{index}].{field} must be a non-empty string")
        if ident in ids:
            raise PoolValidationError(f"duplicate pool id: {ident}")
        ids.add(ident)
        enabled = config.get("enabled")
        if not isinstance(enabled, bool):
            raise PoolValidationError(f"pools[{index}].enabled must be boolean")
        result.append({
            "id": ident,
            "provider": config["provider"],
            "quota_group": config["quota_group"],
            "enabled": enabled,
            "max_concurrency": _positive_int(config.get("max_concurrency"), f"pools[{index}].max_concurrency"),
            "routes": _routes(config.get("routes"), f"pools[{index}].routes"),
            "adapter": config["adapter"],
        })
    return result


def _snapshot_groups(snapshot: Mapping[str, Any]) -> Mapping[str, Any]:
    groups = snapshot.get("quota_groups")
    if not isinstance(groups, Mapping):
        raise PoolValidationError("snapshot quota_groups must be an object")
    return groups


def normalize_snapshot(snapshot: Mapping[str, Any], *, now: float | None = None) -> dict[str, dict[str, Any]]:
    """Validate fixture telemetry and return normalized quota groups.

    Invalid groups are represented as unavailable rather than silently omitted,
    allowing planning to explain why a task was not admitted.
    """
    if not isinstance(snapshot, Mapping):
        raise PoolValidationError("snapshot must be an object")
    now = time.time() if now is None else _finite_number(now, "now")
    result: dict[str, dict[str, Any]] = {}
    for group, raw in _snapshot_groups(snapshot).items():
        if not isinstance(group, str) or not group or not isinstance(raw, Mapping):
            raise PoolValidationError("quota group names and values must be valid")
        item: dict[str, Any] = {"eligible": False, "reason": "invalid_telemetry"}
        try:
            captured = raw.get("captured_at")
            captured = _finite_number(captured, f"{group}.captured_at")
            max_age = _finite_number(raw.get("max_age_seconds"), f"{group}.max_age_seconds")
            if max_age <= 0 or captured > now or now - captured > max_age:
                item["reason"] = "stale_snapshot"
                result[group] = item
                continue
            if not isinstance(raw.get("eligible"), bool):
                raise PoolValidationError(f"{group}.eligible must be boolean")
            windows = raw.get("windows")
            if not isinstance(windows, Sequence) or isinstance(windows, (str, bytes)) or not windows:
                raise PoolValidationError(f"{group}.windows must be non-empty")
            normalized_windows = []
            for window in windows:
                if not isinstance(window, Mapping):
                    raise PoolValidationError(f"{group}.windows contains invalid value")
                used = _finite_number(window.get("used_percent"), f"{group}.used_percent")
                duration = _finite_number(window.get("duration_minutes"), f"{group}.duration_minutes")
                reset = _finite_number(window.get("resets_at"), f"{group}.resets_at")
                if not 0 <= used <= 100 or duration <= 0 or reset <= now:
                    raise PoolValidationError(f"{group} contains an invalid window")
                elapsed = max(0.0, min(duration * 60, now - (reset - duration * 60)))
                target = elapsed / (duration * 60) * 100
                normalized_windows.append({"used_percent": used, "duration_minutes": duration, "resets_at": reset, "pace": used - target})
            active_count = raw.get("active_count")
            if isinstance(active_count, bool) or not isinstance(active_count, int) or active_count < 0:
                raise PoolValidationError(f"{group}.active_count must be a non-negative integer")
            item = {
                "eligible": raw["eligible"],
                "reason": "eligible" if raw["eligible"] else "adapter_ineligible",
                "windows": normalized_windows,
                "max_concurrency": _positive_int(raw.get("max_concurrency"), f"{group}.max_concurrency"),
                "active_count": active_count,
            }
            if any(w["used_percent"] >= 100 for w in normalized_windows):
                item["eligible"] = False
                item["reason"] = "exhausted"
        except PoolValidationError:
            item = {"eligible": False, "reason": "invalid_telemetry"}
        result[group] = item
    return result


def plan_tasks(
    tasks: Sequence[Mapping[str, Any]],
    pools: Sequence[Mapping[str, Any]],
    snapshot: Mapping[str, Any],
    *,
    now: float | None = None,
    active_counts: Mapping[str, int] | None = None,
) -> dict[str, Any]:
    """Assign independent tasks sequentially to currently available pool slots."""
    if isinstance(tasks, (str, bytes)) or not isinstance(tasks, Sequence):
        raise PoolValidationError("tasks must be a sequence")
    configs = validate_pool_configs(pools)
    groups = normalize_snapshot(snapshot, now=now)
    active_counts = {} if active_counts is None else dict(active_counts)
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in active_counts.values()):
        raise PoolValidationError("active_counts must contain non-negative integers")
    assignments: list[dict[str, Any]] = []
    unassigned: list[dict[str, Any]] = []
    task_ids: set[str] = set()
    group_used = {g: groups[g].get("active_count", 0) for g in groups}
    pool_used = {p["id"]: active_counts.get(p["id"], 0) for p in configs}
    for task_index, task in enumerate(tasks):
        if not isinstance(task, Mapping):
            raise PoolValidationError(f"tasks[{task_index}] must be an object")
        task_id = task.get("id")
        requested = task.get("tier")
        minimum = task.get("min_tier")
        allow_promotion = task.get("allow_promotion", False)
        if not isinstance(allow_promotion, bool):
            raise PoolValidationError(f"tasks[{task_index}].allow_promotion must be boolean")
        if not isinstance(task_id, str) or not task_id:
            raise PoolValidationError(f"tasks[{task_index}].id must be a non-empty string")
        if task_id in task_ids:
            raise PoolValidationError(f"duplicate task id: {task_id}")
        task_ids.add(task_id)
        if requested not in TIERS or (minimum is not None and minimum not in TIERS):
            raise PoolValidationError(f"tasks[{task_index}] has an invalid tier")
        selected = None
        candidates = []
        for config_index, pool in enumerate(configs):
            if not pool["enabled"] or pool["quota_group"] not in groups:
                continue
            group = groups[pool["quota_group"]]
            if not group.get("eligible") or group_used[pool["quota_group"]] >= group.get("max_concurrency", 0):
                continue
            if pool_used[pool["id"]] >= pool["max_concurrency"]:
                continue
            candidates.append((max(w["pace"] for w in group["windows"]), config_index, pool, group))
        for _, _, pool, group in sorted(candidates, key=lambda candidate: (candidate[0], candidate[1])):
            tier_index = max(TIERS.index(requested), TIERS.index(minimum) if minimum else 0)
            if TIERS[tier_index] not in pool["routes"]:
                continue
            ahead = any(w["pace"] > 10 for w in group["windows"])
            behind = all(w["pace"] < -10 for w in group["windows"])
            if (allow_promotion and behind and not ahead and tier_index + 1 < len(TIERS)
                    and TIERS[tier_index + 1] in pool["routes"]):
                tier_index += 1
            tier = TIERS[tier_index]
            selected = (pool, group, tier)
            break
        if selected is None:
            unassigned.append({"task_id": task_id, "reason": "no_available_pool"})
            continue
        pool, group, tier = selected
        group_used[pool["quota_group"]] += 1
        pool_used[pool["id"]] += 1
        assignments.append({"task_id": task_id, "pool_id": pool["id"], "provider": pool["provider"], "quota_group": pool["quota_group"], "tier": tier, "route": pool["routes"][tier], "advisory": True})
    return {"assignments": assignments, "unassigned": unassigned, "normalized_snapshot": groups}

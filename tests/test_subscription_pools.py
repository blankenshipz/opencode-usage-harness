import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))
from subscription_pools import PoolValidationError, normalize_snapshot, plan_tasks, validate_pool_configs


def pool(ident="a", group="shared", enabled=True, cap=2, routes=None):
    return {"id": ident, "provider": "fixture", "quota_group": group, "enabled": enabled,
            "max_concurrency": cap, "adapter": "offline-fixture",
            "routes": routes or {"BALANCED": {"model": "m", "effort": "medium"},
                                  "STRONG": {"model": "m-pro", "effort": "high"}}}


def snapshot(*, eligible=True, used=10, captured=990, active=0, cap=2, duration=100, reset=4000):
    return {"quota_groups": {"shared": {"captured_at": captured, "max_age_seconds": 300,
        "eligible": eligible, "max_concurrency": cap, "active_count": active,
        "windows": [{"used_percent": used, "duration_minutes": duration, "resets_at": reset}]}}}


class SubscriptionPoolsTests(unittest.TestCase):
    def test_validation_rejects_duplicates_bools_nan_and_incomplete_routes(self):
        with self.assertRaises(PoolValidationError):
            validate_pool_configs([pool(), pool()])
        with self.assertRaises(PoolValidationError):
            validate_pool_configs([{**pool(), "enabled": 1}])
        with self.assertRaises(PoolValidationError):
            validate_pool_configs([{**pool(), "max_concurrency": float("nan")}])
        with self.assertRaises(PoolValidationError):
            validate_pool_configs([{**pool(), "routes": {"BALANCED": {"model": "m"}}}])

    def test_shared_group_is_counted_once_and_assignments_are_deterministic(self):
        result = plan_tasks([{"id": "one", "tier": "BALANCED"}, {"id": "two", "tier": "BALANCED"}, {"id": "three", "tier": "BALANCED"}],
                            [pool("a"), pool("b")], snapshot(cap=2), now=1000)
        self.assertEqual([a["pool_id"] for a in result["assignments"]], ["a", "a"])
        self.assertEqual(result["unassigned"], [{"task_id": "three", "reason": "no_available_pool"}])
        self.assertTrue(all(a["advisory"] for a in result["assignments"]))

    def test_stale_unavailable_exhausted_and_missing_telemetry_deny(self):
        for kwargs in ({"captured": 100}, {"eligible": False}, {"used": 100}):
            result = plan_tasks([{"id": "x", "tier": "BALANCED"}], [pool()], snapshot(**kwargs), now=1000)
            self.assertFalse(result["assignments"])
        normalized = normalize_snapshot({"quota_groups": {"shared": {"captured_at": 990,
            "max_age_seconds": 300, "eligible": True, "max_concurrency": 1}}}, now=1000)
        self.assertEqual(normalized["shared"]["reason"], "invalid_telemetry")

    def test_pacing_allows_one_tier_promotion_only_when_behind(self):
        behind = plan_tasks([{"id": "x", "tier": "BALANCED", "allow_promotion": True}], [pool()], snapshot(used=1), now=1000)
        self.assertEqual(behind["assignments"][0]["tier"], "STRONG")
        ahead = plan_tasks([{"id": "x", "tier": "BALANCED", "allow_promotion": True}], [pool()], snapshot(used=90), now=1000)
        self.assertEqual(ahead["assignments"][0]["tier"], "BALANCED")
        ordinary = plan_tasks([{"id": "x", "tier": "BALANCED", "allow_promotion": False}], [pool()], snapshot(used=1), now=1000)
        self.assertEqual(ordinary["assignments"][0]["tier"], "BALANCED")

    def test_min_tier_local_concurrency_and_disabled_pool(self):
        result = plan_tasks([{"id": "x", "tier": "BALANCED", "min_tier": "STRONG"}, {"id": "y", "tier": "BALANCED"}],
                            [pool("disabled", enabled=False), pool("live", cap=1)], snapshot(cap=3),
                            now=1000, active_counts={"live": 1})
        self.assertFalse(result["assignments"])
        self.assertEqual(len(result["unassigned"]), 2)

    def test_independent_quota_groups_can_run_in_parallel_and_tier_order_is_canonical(self):
        routes = {"MAXIMUM": {"model": "max", "effort": "high"}, "STRONG": {"model": "s", "effort": "high"},
                  "BALANCED": {"model": "b", "effort": "medium"}}
        second = {"quota_groups": {
            "shared": {"captured_at": 990, "max_age_seconds": 300, "eligible": True, "max_concurrency": 1,
                        "active_count": 0, "windows": [{"used_percent": 1, "duration_minutes": 100, "resets_at": 4000}]},
            "other": {"captured_at": 990, "max_age_seconds": 300, "eligible": True, "max_concurrency": 1,
                      "active_count": 0, "windows": [{"used_percent": 1, "duration_minutes": 100, "resets_at": 4000}]}}}
        result = plan_tasks([{"id": "one", "tier": "STRONG", "allow_promotion": True}, {"id": "two", "tier": "BALANCED"}],
                            [pool("a", routes=routes), pool("b", group="other")], second, now=1000)
        self.assertEqual([a["quota_group"] for a in result["assignments"]], ["shared", "other"])
        self.assertEqual(result["assignments"][0]["tier"], "MAXIMUM")


    def test_sparse_routes_do_not_skip_promotion_rungs_and_minimum_wins(self):
        routes = {"FAST": {"model": "f", "effort": "low"},
                  "MAXIMUM": {"model": "m", "effort": "high"}}
        result = plan_tasks([{"id": "one", "tier": "FAST", "allow_promotion": True}],
                            [pool(routes=routes)], snapshot(), now=1000)
        self.assertEqual(result["assignments"][0]["tier"], "FAST")
        result = plan_tasks([{"id": "one", "tier": "FAST", "min_tier": "STRONG"}],
                            [pool(routes={"STRONG": {"model": "s", "effort": "high"}})],
                            snapshot(), now=1000)
        self.assertEqual(result["assignments"][0]["tier"], "STRONG")

    def test_strongest_window_controls_pool_ranking_and_promotion(self):
        snap = snapshot(used=1)
        snap["quota_groups"]["shared"]["windows"].append(
            {"used_percent": 95, "duration_minutes": 100, "resets_at": 4000})
        snap["quota_groups"]["other"] = snapshot(used=40)["quota_groups"]["shared"]
        result = plan_tasks([{"id": "one", "tier": "BALANCED", "allow_promotion": True}],
                            [pool("a"), pool("b", group="other")], snap, now=1000)
        self.assertEqual(result["assignments"][0]["pool_id"], "b")
        self.assertEqual(result["assignments"][0]["tier"], "BALANCED")

    def test_invalid_or_unknown_windows_and_duplicate_tasks_deny(self):
        for value in (float("nan"), float("inf"), True, -1, 101):
            self.assertFalse(plan_tasks([{"id": "x", "tier": "BALANCED"}],
                [pool()], snapshot(used=value), now=1000)["assignments"])
        for missing in ("windows", "active_count", "max_age_seconds", "eligible"):
            snap = snapshot()
            del snap["quota_groups"]["shared"][missing]
            self.assertFalse(plan_tasks([{"id": "x", "tier": "BALANCED"}],
                [pool()], snap, now=1000)["assignments"])
        with self.assertRaises(PoolValidationError):
            plan_tasks([{"id": "x", "tier": "FAST"}] * 2, [pool()], snapshot(), now=1000)

    def test_existing_group_usage_is_not_added_twice_for_matching_pool_id(self):
        result = plan_tasks([{"id": "x", "tier": "BALANCED"}],
            [pool("shared", cap=2)], snapshot(active=1, cap=2),
            now=1000, active_counts={"shared": 1})
        self.assertEqual(len(result["assignments"]), 1)


if __name__ == "__main__":
    unittest.main()

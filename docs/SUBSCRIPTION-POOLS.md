# Multiple subscription pools

## Status

The project is organized to support independent subscription pools. The first
provider-neutral component is the offline planner in `src/subscription_pools.py`.
It plans parallel assignments from explicit pool definitions and normalized
quota snapshots. It does not authenticate, reserve capacity, launch agents, or
change the live OpenCode profile. The supported runtime remains Codex-only.

Claude, Codex, and other subscriptions are potential separate pools, not assumed
interchangeable authentication methods. Each adapter must verify that the
provider supports the intended subscription access in this client. Possessing a
subscription does not establish that an API or third-party client uses it.

## Separate the concepts

- **Provider:** model transport and catalog namespace.
- **Pool:** an explicitly configured subscription route with a stable local ID,
  adapter, model/effort capabilities, and local concurrency cap.
- **Quota group:** the underlying shared allowance. Routes drawing from the same
  account allowance share this ID, even when they have different names or models.
  Distinct paid subscriptions may have distinct groups. A group is never created
  automatically to evade a provider limit.
- **Task:** required capability tier, minimum acceptable tier for correctness,
  and whether a one-tier quality promotion would be useful. Only independent,
  explicitly delegated tasks belong in the same parallel planning batch.
- **Snapshot:** normalized admission result and quota windows for one group,
  with observation time and current concurrency usage. No credentials belong in
  the snapshot or pool configuration.

Model IDs and reasoning variants come from each adapter's actual catalog. FAST,
BALANCED, STRONG, and MAXIMUM are local routing labels; they do not prove equivalent
capability or equal usage across providers. Do not compare API dollar prices or
raw token counts as if they measured subscription allowance.

## Routing and pacing

First filter for explicit enablement, fresh eligible quota telemetry, remaining
capacity in every limiting window, task capability, and pool/group concurrency.
Then rank eligible choices by their most restrictive window pace delta and configured
order (lower delta first). A window
more than ten percentage points ahead of its elapsed-time target suppresses
optional promotion. A promotion is useful only when the task opts in, all windows
are behind pace, and the selected pool exposes that tier. Never lower a task's
minimum tier to consume an idle pool.

For each reported window:

```
start = resets_at - duration_minutes * 60
elapsed = clamp((now - start) / (duration_minutes * 60), 0, 1)
target_used_percent = elapsed * 100
pace_delta = used_percent - target_used_percent
```

Use all limiting windows rather than assuming a weekly or five-hour slot. Quota
percentages stay scoped to their own groups; they are not summed into a fictional
combined balance. Unknown, stale, reset-pending, or exhausted data cannot establish
admission. Independent groups can contribute workers concurrently; shared groups
consume one shared concurrency budget.

The offline planner checks tier capability only; tool access, data residency, and
task-specific provider eligibility must also be filtered by the future dispatcher.
Group quota eligibility does not authenticate each pool route. A live adapter must
validate each route separately even when several routes share quota telemetry.

The planner's decisions are **advisory**, based on supplied active counts. Two
processes calling it simultaneously can make conflicting plans. Do not wire its
output directly to inference without the reservation layer described below.

## Offline planning example

Run from the checkout root. These are synthetic routes and allowance snapshots,
not working Claude or Codex adapters. The two assignments demonstrate independent
pools contributing one worker each; no inference is performed.

```python
from src.subscription_pools import plan_tasks

now = 1_000_000
pools = [
    {"id": name, "provider": name, "quota_group": name + "-allowance",
     "adapter": "offline-fixture", "enabled": True, "max_concurrency": 1,
     "routes": {"BALANCED": {"model": "fixture-model", "effort": "medium"}}}
    for name in ("provider-a", "provider-b")
]
snapshot = {"quota_groups": {
    pool["quota_group"]: {
        "captured_at": now, "max_age_seconds": 300,
        "eligible": True, "max_concurrency": 1,
        "active_count": 0,
        "windows": [{"used_percent": 20, "duration_minutes": 60,
                     "resets_at": now + 1800}],
    } for pool in pools
}}
plan = plan_tasks(
    [{"id": "explore-module-a", "tier": "BALANCED"},
     {"id": "explore-module-b", "tier": "BALANCED"}],
    pools, snapshot, now=now,
    active_counts={"provider-a": 0, "provider-b": 0},
)
print(plan["assignments"])
```

`active_counts` tracks pool-local workers; each snapshot's `active_count` tracks
all workers consuming that quota group, including other participating routes.
Those counts overlap and must not be added together. Production orchestration
must obtain them from the same atomic reservation store.

## Adapter contract before enabling a provider

An adapter must implement and validate these boundaries:

1. Discover actual subscription-compatible models and reasoning variants.
2. Resolve a local credential reference inside the provider worker, never in the
   planner or telemetry. Match quota identity to the inference identity.
3. Read all applicable allowance windows and any extra-usage, credit, reload, or
   spend-control state. Report unavailable fields honestly. Explicitly verify the
   user's chosen subscription-only financial policy before marking eligible.
4. Fail closed on missing admission evidence, exhausted quota, changed identity,
   or unavailable subscription authentication. Never silently substitute an API
   key, metered endpoint, or another account.
5. Normalize usage and errors while preserving source-specific units and the
   observation timestamp. Keep raw secrets and account identifiers out of logs.

The existing Codex guard and `codex-quota` are the reference runtime integration.
Their OpenAI-specific checks must move behind a tested adapter when the runtime
becomes multi-provider; simply widening `enabled_providers` is insufficient.

## Runtime work still required

- A registry of tested adapters and explicit per-pool opt-in configuration.
- Atomic task leases in a shared local store, enforcing both pool and quota-group
  concurrency. Acquire before launch, recheck fresh admission, renew while active,
  and release after confirmed completion/cancellation. Expired leases require
  reconciliation before retrying work that may still be running.
- Task-ID idempotency, worker ownership, and branch/worktree isolation for parallel
  edits. Reassignment must not launch duplicate work or abandon active workers.
- Explicit eligible-pool lists per task, provider outage/cooldown handling, and
  cancellation/collection before rerouting. Pool selection is planned delegation,
  never an implicit billing fallback.
- Provider-specific usage reservations where reliable estimates exist. Concurrency
  caps alone cannot promise a hard percentage budget; admission checks race with
  other clients using the account. Provider-side spend controls remain necessary.
- Per-pool telemetry: selected model/effort, quota before/after, elapsed time,
  retries, task outcome, and reservation identity. Preserve unknown attribution
  when other account activity prevents exact accounting.
- Opt-in independent-provider reviews when the quality benefit justifies the
  capacity. Stop after acceptance; do not invent work just to empty subscriptions.

Acceptance for each new provider includes fixture failures, concurrent admission
and crash-recovery tests, then an authorized real subscription run demonstrating
correct identity, allowance use, no metered fallback, and preserved task state.
Until then, its adapter is unavailable for live routing.

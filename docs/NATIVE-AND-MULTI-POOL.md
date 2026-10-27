# Native and multi-pool workflow

This page describes the boundary between stock OpenCode agents and the
harness's managed routing path. It also documents the opt-in policy for using
independent subscription pools.

## Native Build, Plan, General and Explore

The generated profile enables OpenCode's stock `build`, `plan`, `general`, and
`explore` agents. They use the same OpenCode server and native model selection
as any other stock session. Their child calls keep the native subagent schema
and tool behavior, so a fresh native chat avoids managed task ownership.

Native agents bypass harness model routing, the 350-line large-file mediation,
and optional result compression. They still pass through the subscription
financial guard and native permission system. A native call cannot adopt a
managed child or take over an unfinished managed task. Native subagent dispatch
also waits while a registered harness writer is active in the workspace; this
is not a comprehensive lock on all native filesystem edits. Resume managed work with its recorded `taskId`/`workKey` through
`task_dispatch`; start a fresh native chat for independent stock work.

Use the harness roles and `task_dispatch` when the task needs durable ownership,
write-path accounting, checkpoints, routing metadata, review evidence or sticky
continuations. Native eligibility is not a permission grant: OpenCode remains
the authority for tools, model access and approvals.

## Enabling multi-pool routing

Tier references determine the provider allowlist. All-OpenAI tiers produce an
OpenAI-only profile; all-Anthropic tiers produce a Claude-only profile. Mixed
tiers enable both. Four tiers do not require four different models. No routing
policy is required for single-pool operation.

A policy can add approved candidates within one pool or across pools; only
an enabled policy's enabled candidates add providers. Quota reads use the enabled
runtime catalog and do not contact an absent provider. Cross-family review is
optional; same-family review works normally with one subscription.

Prepare a profile with an optional reviewed policy and separate provider setup:

```sh
python3 configure.py --models /absolute/path/to/models.json \
  --routing-policy /absolute/path/to/routing-policy.json
```

The example policy is [`config/routing-policy.example.json`](../config/routing-policy.example.json).
It is a disabled illustrative two-provider policy; remove unneeded candidates
and use IDs discovered in your own catalog. It lists candidates per role and uses
`provider/model#effort` catalog references. Candidates are capability peers in
the approved role; they are not ranked by API price, raw token counts or
provider brand. The policy may include OpenAI and Anthropic, but Claude also
requires the reviewed Claude Code OAuth artifact with extra usage disabled.

Every fresh routed admission checks the selected provider's live, sufficiently
fresh windows, the native catalog and the financial boundary. OpenAI and Claude
windows are independent. A Claude Fable candidate requires a matching scoped
model limit; an account window alone is insufficient. The adapter reads the
currently selected Claude OAuth identity. The standalone quota command cannot
do that and reports Claude as unknown with `adapter_unavailable`.

After admission, the selected model is sticky for continuations and retries do
not switch providers. A fresh admission can choose another eligible candidate;
`resetModel: true` clears override metadata while retaining an admitted route, while an explicit
manual model override wins. Unknown, stale or exhausted telemetry retains the
configured role or fails the separate admission guard; it does not authorize a
paid fallback.

## Reviews and behavior profiles

Set `routing.reviewOf` to the admitted model reference only when the task calls
for a meaningful independent peer review. The policy prefers a capable healthy
candidate from another provider family when available. This is a routing hint,
not an automatic review: the parent must create and accept the review, and no
review is generated merely because another pool has capacity.

Behavior profiles are version-specific. The example policy marks every profile
`example_unvalidated`; replace its model references and record your own evidence.
No example claims measured capability or savings for another installation. Measure
accepted validation, confirmed review findings, repairs, user corrections,
elapsed time and observed quota windows. Do not infer behavior from provider
stereotypes, equal effort labels or API prices. Keep the task acceptance contract
stable while collecting evidence; a profile becomes useful through confirmed
findings and repairs, not a brand ranking.

## Limits

The planner and routing policy do not create a global concurrency reservation,
guarantee quota exhaustion, or promise subscription savings. Other clients can
consume the same allowance between observation and dispatch. Quota pace is
advisory and helps choose among already eligible candidates; it never invents
work, lowers a task's minimum capability, or triggers an automatic review.

The default root router is unchanged. Enabling a policy does not replace native
permissions, financial admission, account identity checks or provider-specific
OAuth requirements. See [Claude subscription setup](CLAUDE-SUBSCRIPTION.md),
[usage controls](USAGE-CONTROLS.md), and [subscription pools](SUBSCRIPTION-POOLS.md)
for the related boundaries.

## Changing back to one pool

Supply all four tier references from the retained provider, then run
`configure.py --models /absolute/path/to/models.json --replace` without
`--routing-policy`. This backs up the prior generated profile and any existing
managed routing policy, then removes that policy so it cannot silently restore
old dual-pool routing. It does not delete account credentials or change a running
service; review and activate the generated profile separately.

Claude-only admission requires its reviewed OAuth adapter and disabled usage
credits; no Codex login or OpenAI financial-verification file is required. OpenAI
admission still requires its own OAuth/account and financial checks. Unknown quota
in an enabled pool never authorizes inference through a different provider.

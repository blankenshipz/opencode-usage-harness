# OpenCode Usage Harness

**Put your coding subscription to work where it matters.** Give routine exploration
to a smaller model, reserve deeper reasoning for difficult problems, and pace work
against your actual quota resets—all from OpenCode.

OpenCode Usage Harness adds task routing, context controls, and usage visibility to
your coding workflow. The goal is more useful, verified work from the capacity you
already pay for—using **ChatGPT/Codex, Claude, or both** with the compatible
subscription integration. Stronger models and additional review belong where they improve
the result; unused quota alone is no reason to manufacture work.

**Start with [quota visibility](#install-the-toolkit), then
[enable the agent workflow](#enable-agent-integration-separately).** Interested in
combining several subscriptions? Explore the [pool planner and architecture](docs/SUBSCRIPTION-POOLS.md)
and the [native and multi-pool workflow](docs/NATIVE-AND-MULTI-POOL.md) before
[helping build the next integrations](#contributing).

## What you get

The standalone toolkit's `install`/`update` commands switch its tool release only;
they do not activate an OpenCode runtime. For a recovery runtime candidate, use
the separate [stage → provenance → activate procedure](docs/recovery-release.md).
Publishing or installing the toolkit does not make native runtime patches live.

| For your workflow | What the harness provides |
|---|---|
| Choose the right level of reasoning | Specialist roles for exploration, implementation, debugging, architecture, and review, mapped to models and efforts you select from your actual catalog. |
| See whether capacity is running out or going unused | Independent OpenAI/Codex and Claude quota views, reset times, pacing, and model-scoped limits where exposed; missing data stays unknown. |
| Combine model strengths with quota pacing | Task-specific, evidence-backed preferences among approved model/effort peers; independent quota balancing, sticky continuations and optional cross-family review. |
| Keep large files from crowding the main agent's context | A 350-line broad-read threshold, focused worker summaries, targeted reads, and reasoned one-use exceptions. |
| Keep delegated work connected to the task | A stable integration owner first delivers an executable end-to-end slice, while workers complete meaningful implementation and verification chunks with recorded acceptance evidence. |
| Understand what your agents accomplished | Workload metrics for usage, observed execution time, retries and reported acceptance, with overlap and unknowns called out. |
| Keep subscription-only inference explicit | Provider-specific subscription OAuth and financial admission: Codex account/credit checks, Claude usage-credits-disabled verification by default, and no automatic API-key/provider fallback. An operator may explicitly select the documented Anthropic app-managed-credit mode. |
| Adopt changes incrementally | An isolated toolkit installer, versioned updates, integrity checks, and code rollback. |

A typical workflow is: **check quota → inspect only the relevant code → let one
integration owner deliver an executable end-to-end slice → route independent,
meaningful implementation and verification chunks → repair or escalate when the
evidence warrants it**. A separate scout is useful when discovery is needed, not
a required extra agent for every task. The full workflow requires the compatible
agent integration; installing the standalone tools does not activate it automatically.

Recovery status distinguishes a running compaction, successful compaction awaiting
same-child continuation, and failed compaction awaiting recovery. Recoverable Codex
quota-telemetry failures keep admission closed and retain generation-bound parent notifications;
notification delivery never resumes inference. See the
[staged recovery release and activation procedure](docs/recovery-release.md) for
compatibility, artifact verification and live-install limitations.

## How model and reasoning selection work

The behavior below describes the current development branch and its compatible
V2 agent integration, not everything in the v0.1.0 toolkit release.

The public profile uses four user-supplied tiers: **FAST, BALANCED, STRONG and
MAXIMUM**. Each maps to an actual `openai/<model-id>#<variant>` or
`anthropic/<model-id>#<variant>` reference discovered
in your account's catalog. The variant selects the reasoning effort supported by
that model. The harness does not assume particular model names, a universal effort
ladder, or that API prices describe subscription consumption.

The generated profile in [configure.py](configure.py) maps roles as follows:

| Agent | Configured tier | Intended work and capabilities |
|---|---|---|
| `harness-router` | STRONG | Own the goal, choose workers, integrate evidence; no shell or edits. |
| `harness-coordinator` | BALANCED | Coordinate multiple sustained lanes through terminal workers; no shell or edits. |
| `harness-scout` | FAST | Focused repository exploration and summaries; no shell, edits or delegation. |
| `harness-quick-builder` | FAST | Mechanical fixes, small localized changes and straightforward tests. |
| `harness-builder` | BALANCED | Ordinary implementation and feature work. |
| `harness-deep-debugger` | STRONG | Ambiguous failures and difficult debugging. |
| `harness-architect` | STRONG | Design and consequential analysis; no shell or edits. |
| `harness-reviewer` | STRONG | Correctness, regression and risk review; no shell or edits. |
| `harness-verifier` | STRONG | Execute assigned checks and report results; no direct edit tool or delegation. Shell can write, so ownership and command approvals still apply. |
| `harness-maximum` | MAXIMUM | Exceptional problems where the expected quality improvement justifies the capacity. |

Only the router and coordinator delegate; other roles are terminal workers.
Shell-capable roles still obey native command permissions. Assign executable checks
using `operation:verify` and `harness-verifier`, preserving an explicitly requested
OpenAI or Claude model. Verification implies shell capability and reserves write
ownership, including for test-generated files; it is not a read-only sandbox.
Static review stays with `harness-reviewer`. A preflight
`TASK_DISPATCH_CAPABILITY_MISMATCH` means a new assignment selected an incapable
role. The parent corrects that assignment while preserving the requested model
and scope; the normal permission, ownership and financial checks still run. This
diagnostic neither clears a prior denial nor permits replacing an existing worker.

**Selection is task → role → configured model and effort.** The parent is instructed
to choose the smallest capable worker, accounting for complexity, risk, prior
verification and quota pressure. One bounded task normally goes directly from the
router to one worker. A coordinator or independent review is justified by the task,
not added automatically. Passing, sufficient verification is a reason to stop;
uncertainty alone is not a reason to escalate.

By default, every role sharing a tier also shares its configured reasoning variant.
There is no automatic low/medium/high effort optimizer or measured price ranking.
At an explicit `continuationEffort: "reassess"` request, a completed, idle,
ordinary normal-risk `builder` implementation may move from `#high` to `#medium`
only when the current catalog advertises the same provider and base model at
`#medium`. The routing record reports the request, outcome, reason, and catalog
provenance. It never changes a running, failed, denied, cross-family-review, or
explicitly/manual-model-overridden worker; unavailable medium variants retain the
admitted route with an explicit reason. Customize role references explicitly when
different efforts are appropriate. The
public generator selects STRONG for the router; it does not dynamically demote the
primary router. An existing private profile may have different role assignments.

Every admitted worker dispatch, including a continuation, passes the effective
model reference to OpenCode so an old child does not silently retain an obsolete
model. An explicit dispatch `model` override persists for that work key;
`resetModel: true` clears override metadata while retaining an admitted route. A UI model change observed
after a known harness selection is also preserved. Legacy children have no override
provenance: their next dispatch adopts the configured role unless an explicit
model is supplied. This does not change inference already running. Dispatch status
shows configured, selected and previously observed models; completed-response
telemetry is the evidence for what actually ran.

### Native OpenCode workflows

The generated profile leaves OpenCode's stock `build`, `plan`, `general`, and
`explore` agents enabled. A fresh native chat can use the same server and native
model selection with the stock tool contracts; it does not enter managed task
ownership. Native calls bypass harness routing, large-file mediation and optional
result compression, while the subscription financial guard and native permission
checks still apply. A native call cannot adopt a managed child or run beside a
known managed writer; continue that work through its recorded harness owner.

Use `task_dispatch` for durable harness work: it records ownership, routing,
review evidence and continuations. The built-in agents can still be useful for a
small independent task or a fresh native chat when that durable contract is not
needed.

Configured harness agents are shown with `harness-` names, such as
`harness-router` and `harness-builder`. Historical unprefixed IDs remain hidden
compatibility aliases so existing sessions can resume with their exact stored
agent identity; new handoffs should use the visible prefixed names.

### One pool or multiple pools

**One subscription is enough.** Use OpenAI only, Claude only, or both:

| Your subscriptions | Tier mappings | Enabled providers |
|---|---|---|
| ChatGPT/Codex only | All four tiers use discovered `openai/...#variant` references | OpenAI only |
| Claude only | All four tiers use discovered `anthropic/...#variant` references | Anthropic only |
| Both | Mix tier references, or opt into approved role candidates | Only providers named by tiers and enabled candidates |

The generator derives provider access from your mappings; it does not require
OpenAI for a Claude-only profile. You may map several tiers to the same model.
Native agents, context controls, verification and same-family review work with a
single pool. Cross-family review is an optional preference and never requires a
second subscription. Runtime quota tools query only providers in the enabled
model catalog, so a Claude-only setup does not invoke Codex CLI or read its auth.

To enable quota-aware choice among role candidates, pass an explicitly reviewed policy to
`configure.py --routing-policy`; only enabled policies and enabled candidates expand provider access. The policy is
written beside the generated profile. It does not authenticate Claude or make
Claude eligible by catalog visibility alone. Each role's candidates must be
actual catalog model/effort references, and Anthropic still requires the guarded
Claude Code OAuth artifact and extra usage disabled. See
[native and multi-pool routing](docs/NATIVE-AND-MULTI-POOL.md) and
[Claude subscription setup](docs/CLAUDE-SUBSCRIPTION.md).

Admission reads independent provider windows and the selected OAuth identity.
Selection happens for a fresh admission; continuations stay sticky to the
admitted model, and an explicit manual model override wins. A depleted or
unavailable pool is not retried through another provider. `reviewOf` requests a
meaningful independent peer review only when the policy has a healthy capable
peer; the harness never creates an automatic review.

### Task fit, model families and independent review

`harness-router` is the default primary agent in generated harness profiles. Its
own model stays configured; delegated tasks use the enabled peer-selection policy.
Selecting native Build/Plan intentionally bypasses harness orchestration. External
bridges must explicitly enter through the harness; installing the router does not
make every client use it.

The router decides **whether review is useful** before the dispatcher chooses a
model. Skip extra review for trivial passing work. Prefer one bounded cross-family
review for security, concurrency/state, substantial architecture, weak coverage or
repeated failed repairs. Give the reviewer requirements, the diff and validation
evidence; reconcile actionable findings and perform targeted repairs. Additional
review needs a concrete unresolved risk. Spare quota alone is not a review trigger.
Managed reviews identify the implementation worker with `routing.reviewOfChildID`;
the dispatcher resolves its model rather than trusting a model-name claim.
Use `reviewIndependence: "preferred"` normally and `"required"` for an explicit
user requirement. Legacy `reviewOf` strings remain unverified hints.
Same-family review remains valid when a suitable independent pool is unavailable;
an explicit requirement for cross-family review must be reported as unavailable
rather than silently substituted. A single-subscription installation remains valid.


Selection combines **task fit → suitable model/effort peers → independent quota
pace**. An optional `routing.taskType` classifies exploration, mechanical changes,
implementation, debugging, architecture, testing, review or general work. Older
callers infer a task type from the harness role. Tool capabilities remain separate:
a file-only reviewer still cannot execute a requested test.

Each exact candidate reference can declare a task-specific `preferred` or
`acceptable` band. Only `preferred` rules marked `supported` with an evidence
reference affect the quality preference; missing or provisional rules remain
neutral. A reference records an operator-reviewed claim, not automatic proof.
The shipped example and the initial live policy keep unproven pairs acceptable
and provisional rather than inventing a winner for a provider family.

| Work | How fit and quota combine |
|---|---|
| Routine, normal risk | Quota pace chooses among approved adequate peers. |
| Standard, normal risk | A healthy supported-preferred candidate wins over acceptable peers; pressure or unavailability can justify an acceptable healthy peer for new work. |
| Complex or high risk | Declared supported-preferred candidates set the fit floor. Spare quota cannot silently substitute an acceptable model. If selection cannot meet the floor, the router reports `ROUTING_TASK_FIT_UNAVAILABLE`; an exact preferred configured model may still go through normal financial admission. |
| Meaningful independent review | Prefer another family within the eligible fit/health group, without automatically creating a review. |
| Explicit model or admitted continuation | Manual selection or recorded affinity wins within any explicitly required review-independence constraint; financial and native permission gates still apply. |

With an enabled routing policy, new managed assignments must include `routing`
complexity and risk; omission returns `ROUTING_ASSESSMENT_REQUIRED` before admission.
Existing admitted children retain their identity and route, and native Build/Plan
keep their stock contracts. Unknown policy fields, invalid reserves and unresolved
profile references are rejected.

The local fit policy is retained when quota reads fail. Invalid policy raises a
sanitized error instead of falling through silently. Routing status records the
task type, effective band, evidence status and decision explanation without copying
private evidence references. See [policy configuration and examples](docs/NATIVE-AND-MULTI-POOL.md#task-fit-preferences).

Candidate behavior-profile guidance remains useful alongside these rules. Judge
strengths per model version, reasoning effort and task type using accepted results,
repairs, confirmed review findings, user corrections, elapsed time and actual quota
observations. The harness does not automatically promote a preference or learn a
brand ranking from self-reported success; evidence-based policy updates remain
explicit. A single-family setup uses the same rules and needs no second subscription.

### Quota monitoring: shared view, provider-specific evidence

In a managed OpenCode session, ask the agent to call **`subscription_quota`**.
It reports separate `openai` and `anthropic` pools for enabled catalog providers,
including available windows, utilization, reset timestamps, pacing and relevant
financial/scoped-limit metadata. Reading quota performs no model inference.
A missing, stale or failed read is **unknown**, not zero usage or extra capacity.

| | OpenAI / ChatGPT Codex | Anthropic / Claude |
|---|---|---|
| Evidence source | Authenticated Codex CLI app-server, `account/rateLimits/read`; admission verifies the OpenCode and CLI account match. | Usage endpoint for the **selected Claude Code OAuth connection** inside OpenCode; no API key or other account is substituted. |
| Windows | Uses the durations and resets actually returned; does not assume a five-hour or weekly window exists. | Reads session, account-wide weekly and model-scoped limits when present. Reported durations take precedence; recognized five-hour/seven-day windows without durations are marked `duration_source: inferred`. |
| Scoped capacity | Preserves reported Codex buckets in the CLI output; the shared pool view currently treats normalized Codex windows as account scope. | Preserves model/family scope, locks and weekly-share metadata when provided. A model-scoped allowance is a constraint within the subscription, not a second pool to add to the total. |
| Financial evidence | Credit-risk metadata plus separate account/financial verification. | Usage credits (`extra_usage.is_enabled`) must be explicitly disabled, unless an operator installs the exact local app-managed-credit acknowledgement described in [Claude connection setup](docs/CLAUDE-SUBSCRIPTION.md#optional-app-managed-usage-credits). |
| Access outside OpenCode | `codex-quota` provides human-readable or JSON output, refresh and admission checks. | The standalone `subscription-quota.mjs` has no selected OpenCode OAuth context, so it reports Claude as `unknown [adapter_unavailable]`; use the in-session tool for Claude. |

Recent short-window consumption is also exposed as an **advisory burn rate and approximate exhaustion time**, using fresh samples from the same selected credential and reset window. It adds no polling, admission gates or worker budgets. Claude supplies the private identity needed for this history; the current Codex adapter reports this new trend as unknown (its existing window pacing still works). See [short-window pacing](docs/SHORT-WINDOW-PACING.md) for freshness and identity limits.

The explicit `codex_quota` tool remains Codex-only. The shared tool and automatic
routing query only enabled subscription providers; a Claude-only profile does not
need a Codex login or CLI. A local `/quota` shortcut can call the shared tool, but
the public profile generator does not install that slash command automatically.

Financial admission is separate from this advisory view. OpenAI checks matching
OAuth identity, current Codex admission and the configured financial attestation
(no purchased-credit balance, automatic top-up or reload). Claude checks selected
subscription OAuth and disabled usage credits. Claude shares usage telemetry across
routing and admission, and rejects confirmed applicable exhaustion. On a transient
lookup failure, admission may use an existing verification of disabled usage credits
for less than 24 hours from its original successful read. Quota telemetry is still
fresh for only 60 seconds and stale telemetry remains unsuitable for routing. Expired financial evidence,
authentication failures, and enabled or unknown usage credits still block admission.
The only exception is an explicit private `app_managed_credits` policy for an
operator-managed Anthropic app cap; it keeps OAuth/provider validation but lets
the provider app enforce spending, without local balance accounting or a fallback
after a provider limit.
The provider remains the final included-quota hard stop; no Codex-style subprocess
is required for Claude.
Neither path admits API-key billing or automatically retries with another provider.
Account-side changes and concurrent usage mean these controls are not a billing
guarantee; see [security boundaries](SECURITY.md).

### Quota pacing and model adjustment

For a window with utilization, a usable duration and a future reset, the shared
view calculates `window_start = reset - duration`, elapsed fraction clamped to
0–1, and `pace_delta = used_percent - elapsed_fraction × 100`. Claude's inferred
durations remain labeled as estimates; missing reset/usage data cannot establish
pace. Account-wide pace and model-scoped constraints are kept distinct.

At meaningful dispatch boundaries, the parent supplies task complexity and risk.
Codex retains its short-lived file cache and cross-process lock. Claude uses a
60-second shared private cache and coalesces concurrent lookups across processes.
Transient failures trigger a cooldown (respecting Retry-After, with bounded
exponential backoff when needed), not repeated requests from each worker. Quota
estimates older than two minutes remain unsuitable for candidate selection.
The separate 24-hour Claude financial-verification limit never moves forward on a
cache hit or failed lookup; stale quota does not mean unused capacity. A changed
Claude setting can remain unobserved until the next successful usage read, so keep
usage credits disabled in the account as well. See
[Claude telemetry caching](docs/CLAUDE-SUBSCRIPTION.md#shared-telemetry-and-bounded-recovery).

**If a usable account window for the role’s provider is more than ten percentage
points ahead of pace, or has at most 10% remaining**, an explicitly routine,
normal-risk `harness-builder` or `harness-deep-debugger` dispatch can use the configured
`harness-quick-builder` model and variant within the same provider. This is a specific
role substitution, not a general one-rung search across all tiers. The worker keeps
its original role, permissions and ownership.

With an enabled candidate policy, fresh work can instead choose among explicitly
approved model/effort peers using account and matching model-scoped pressure.
Within the task-fit rules above, the selector compares each provider’s own windows; quota percentages are never
added together. It favors healthy, approved capability peers, considers the
limiting applicable weekly window and its reset, and applies a configurable
reserve (2% by default). More useful work can go to the pool further behind pace
or closer to losing unused capacity, without changing the task’s required tier. This is an admission-time
choice, not a retry after another provider rejects work. Candidates that require
scoped quota are ineligible when that evidence is missing. A weekly meter above 90% can still be used near reset when it is on pace and
above the reserve; short-window pressure remains a constraint. Concurrent sessions
can consume quota after a read; there are no atomic quota reservations.

High-risk work, explicit overrides and other roles are not automatically demoted.
Absent routing classification or usable telemetry retains configured selection;
the independent financial guard still blocks inference when admission cannot be
established. Behind-pace capacity does not automatically promote a model, launch a
review or generate work. The parent may choose stronger reasoning or useful extra
verification when justified. The objective is useful prepaid capacity, not token
burn or a guaranteed 97–100% utilization target.

## Usage optimizations and their limits

These controls work together; some are automatic middleware, some are dispatch
rules, and others are instructions for the agent. They apply to harness roles
using either model family; native agents retain the bypass described above. None establishes a hard spending
ceiling or a promised percentage saving.

| Optimization | Behavior and limits |
|---|---|
| **Short instructions and focused handoffs** | Revisioned task intent carries the goal, authorization and checks; workers use that injected intent until a revision, compaction, or specific evidence gap requires a refresh. Handoffs add bounded objectives, changed files, current checks and unresolved findings, linking retained evidence instead of repeating logs. Status is recorded at decision or recovery boundaries, and exact tool-schema names and required fields avoid repeated malformed calls. |
| **Large-file read control** | The guard blocks broad reads over the 350-line threshold while allowing targeted ranges. A focused smaller worker can return a summary; terminal workers cannot recursively delegate. An eligible writer can request a reasoned one-use direct-read exception. Agents are told not to page through a whole file to evade the guard; ordinary permissions still apply. |
| **Recoverable tool-result compression** | Automatic V2 middleware compacts eligible new JSON, rectangular arrays and plain search listings, collapses exact consecutive repetitions in recognized test/build logs, and shortens unchanged Git diff context. Every JSON row/value and every diff change remains represented. It adds no inference call. |
| **Exact originals on demand** | A profitable projection is published only after its exact original is stored privately. Retrieval uses bounded native reads under existing permissions. Source reads, edits, patches, unknown tools and nested CodeMode fallback text are not rewritten. Malformed, oversized or unprofitable results pass through. A snapshot is not proof of current file contents. |
| **Stable history and cache diagnostics** | Tool compression happens once on new results, without repeatedly rewriting history. Passive cache monitoring observes instruction/tool/early-message changes and reported cache-token counters. It does not alter cache headers, guarantee cache hits or perform inference. |
| **Selective conversation compaction** | Real context pressure can produce an advisory. The parent can request native same-session compaction at an idle checkpoint with no active descendants, keeping ownership and refreshing intent afterward. Continuation waits for the matching durable outcome. This is opt-in, can consume included inference and does not clone the worker. |
| **Same-worker resumption** | Stable task/work keys and ownership reuse the existing child instead of launching replacements. Revision and assigned-check bindings help prevent stale scope from carrying forward. Explicitly marked historical copies point to the canonical chat and cannot start competing inference; old copies are not automatically discovered or merged. |
| **Bounded work and cumulative review** | A cooperative reminder after ten minutes or 30 prepared model steps reports progress and scope; it does not cancel tools or direct a worker to return. The worker continues authorized useful implementation and targeted verification until the objective is verified, a real blocker appears, or the approach changes. At the next idle admission, 120 steps/six continuations per lane or 240 steps/12 continuations across the root task require an agent-supplied evidence-backed reassessment. Totals survive handoffs; this is not a new human approval gate. |
| **Repeated-work detection** | Two continuations without new reported progress produce a convergence advisory. Changed wording, timestamps or artifact churn alone do not count as progress. Evidence remains self-reported and must be checked; the advisory is not an automatic stop or extra review call. |
| **Verification reuse and retained diagnostics** | Instructions favor targeted checks, reuse of unaffected passing evidence and follow-up reviews of changed findings. Substantial checks retain stdout, stderr, exit status and revision in private receipts, with bounded previews and disk-space checks. Necessary tests still run; avoiding quota is not a reason to skip requested validation. |
| **Actionable worker recovery** | Revised intent still requires parent authorization. Status identifies the existing child and current revision for an explicit rebind; no automatic inference or replacement worker. Human-action checkpoints use `status=blocked`, `progressState=needs_user_action`, and concrete blocker evidence. |
| **Git workflow discipline** | Instructions prohibit precautionary hook bypasses and require explicit authorization to disable checks. When shared Git state overlaps, agents discover the actual shared metadata directory, include it and the target checkout in `writePaths`, and coordinate that narrow `commonGit` scope serially. This guidance does not create an automatic or blanket hold, and native command approvals still apply. Isolated launchers can preserve GitHub CLI's existing configuration directory without copying credentials or forwarding API tokens. |
| **Useful human/device attempts** | Optional verification records retain readiness, expected signal, result references and expiry so agents inspect prior evidence before asking for another live test. They do not verify a physical device themselves or turn expiry into an automatic retry. |
| **Background completion and health visibility** | Sustained implementation, coordination and deployment default to native background work; completion resumes the parent. Guidance discourages polling and duplicate workers. At decision or recovery boundaries, a bounded status summary keeps the owner oriented; full status is used only for a specific evidence gap. Read-only health checks prioritize pending native forms/permissions over the running flag and keep unavailable evidence unknown. Status distinguishes historical outcomes from current execution; idle is not accepted completion. These tools do not automatically reply, retry or restart services. |
| **Generation-bound review readiness** | An explicit `task_dispatch_collect` records an exact background generation's terminal native evidence without another inference call. Review rechecks that evidence instead of accepting an old successful answer or an idle flag. Legacy unbound work is not silently certified. |

Compression only considers results from 4,096 characters up to 1 MiB and requires
at least 512 characters and 15% savings, including retrieval instructions. The
private original store is bounded; once full, new results pass through instead of
evicting evidence. These are character reductions, not measured subscription-token
savings. Provider-hosted tools and background completion results are not covered
by this local compression hook.

For operational details, see [routing, review thresholds and compaction](docs/USAGE-CONTROLS.md),
[compression and retrieval](docs/CONTEXT-COMPRESSION.md),
[diff previews](docs/DIFF-PREVIEWS.md), [compression diagnostics](docs/COMPRESSION-DIAGNOSTICS.md),
[cache monitoring](docs/CACHE-DRIFT.md), [convergence and live attempts](docs/CONVERGENCE.md),
and [execution, receipts and outcome telemetry](docs/TELEMETRY.md).

### Measure outcomes, not just smaller prompts

Use `harness-metrics` to compare completed work, reported acceptance, retries,
observed execution time, input/output/cache tokens, compression characters and
cache-drift observations. Compare those with actual quota deltas during ordinary
work. Other Codex clients or Claude clients may consume the same provider’s
account-wide allowance. Cache counters and token accounting vary by provider;
missing counters are not zero, cached tokens are not assumed free, and API token
prices do not measure subscription consumption. Retained
receipts and tests support acceptance; metric counts alone do not prove correctness
or savings.

The generated profile allows only providers named by its tier mappings and enabled
routing candidates. OpenAI and Anthropic subscription admission are independent; see [Claude connection setup](docs/CLAUDE-SUBSCRIPTION.md).
OAuth/account checks and provider-specific financial admission remain separate from optimization. Quota pressure never authorizes
purchased credits, API-key inference or an automatic paid/provider fallback.
Compression and context diagnostics are model-family-neutral middleware; that does
not enable additional subscription providers automatically.

## What works today

This is an **experimental project** extracted from a working private installation.
The standalone installer and utilities are independently usable. The current
source includes **ChatGPT/Codex OAuth** admission, a separately installed and
reviewed **Claude Code OAuth adapter**, and opt-in dual-pool routing. Claude-only
and Codex-only profiles are also supported by the generator and offline tests.
The Claude adapter is third-party and uses an internal usage endpoint; its
availability and subscription eligibility are not guaranteed. Review
[Claude setup and limitations](docs/CLAUDE-SUBSCRIPTION.md).

The original public runtime reference is **OpenCode 2.0.18 plus the required-plugin
patch**. The later managed **2.0.30** recovery patch has a separate hash-pinned
baseline and [activation procedure](docs/recovery-release.md); these are not
interchangeable patches or certification of stock OpenCode.

A fresh end-to-end public installation, stock/newer OpenCode versions, and Windows
are not yet certified. OpenChamber installation and remote pairing are not included.
Read [compatibility](docs/COMPATIBILITY.md) before changing your agent setup.

The harness does not promise a percentage saving or a hard billing guarantee.
Provider-side subscription eligibility and spend controls still matter. See
[security and limitations](SECURITY.md). This project is independent of OpenAI,
Anthropic, OpenCode, OpenChamber, Spotify, or Headroom.

## Multiple subscriptions

The longer-term goal is to put **Codex, Claude, and other eligible subscriptions to
work in parallel**, choosing tasks and model/effort combinations for each pool's
capabilities and remaining allowance.

The current development branch includes a provider-neutral **offline planner**
that models independent pools, shared quota groups and per-window pacing without
counting two routes to one allowance as extra capacity. Separately, the opt-in
live router selects approved OpenAI/Claude role candidates from their quota views. There are no global concurrency reservations and no guarantee that a
pool will be exhausted or that routing will save money. **Live multi-provider
routing remains opt-in**; each adapter must verify subscription access, quota
identity and financial controls first.

See the [native and multi-pool workflow](docs/NATIVE-AND-MULTI-POOL.md) and the
[architecture and runnable fixture example](docs/SUBSCRIPTION-POOLS.md).
This planning foundation is scheduled for 0.2.0 and is not in the v0.1.0 release.

## Remaining work and next steps

The next milestones are:

- **Make the first installation repeatable.** Validate a fresh public setup end to
  end, automate compatible runtime builds, and document verified platform coverage.
- **Connect the planner to safe parallel execution.** Add atomic reservations,
  crash recovery, task idempotency, and ownership checks before runtime dispatch
  across pools. Advisory slot counts alone are insufficient.
- **Add subscription adapters one at a time.** Verify supported authentication,
  model/effort discovery, quota telemetry, and no metered fallback for each provider.
  Claude already has an opt-in OAuth/financial adapter, quota monitoring and
  candidate-based pacing/routing in the development branch. Harden that integration
  against endpoint changes; additional providers remain candidates.
- **Validate usage improvements in ordinary work.** Compare accepted results, cumulative
  work, effective models, compaction outcomes and actual quota deltas. Model-step
  thresholds are reassessment points, not hard spending limits.
- **Measure useful outcomes across pools.** Attribute task results, retries,
  elapsed time, and quota changes without equating token counts to subscription
  dollars. Evaluate independent-provider review where it adds value.
- **Improve distribution and remote setup.** Add signed releases, compatible
  binaries where practical, and documented OpenChamber setup and pairing.

**For users:** try the released quota tools first, check compatibility, and report
installation or workflow gaps with a sanitized reproduction. **For contributors:**
pick a bounded milestone above and propose how to validate it. The [changelog](CHANGELOG.md)
separates released functionality from development work; these milestones are not
promises of a release date.

## Contributing

Help make subscription-aware coding practical across more setups. Useful
contributions include first-install reports, regression tests, clearer onboarding,
provider adapter designs, and fixes for task routing or context handling.

1. [Open an issue](https://github.com/blankenshipz/opencode-usage-harness/issues) with
   the problem, expected behavior, and a small sanitized reproduction. Discuss new
   adapters or runtime changes before building a large integration.
2. Make a focused change with fixture-based tests. Keep credentials, account data,
   chat histories, and runtime state out of the repository.
3. Run the offline checks below and open a pull request explaining the behavior
   change, validation, and remaining limitations.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for test and release requirements and
[SECURITY.md](SECURITY.md) for the current safety boundaries. Automated tests should
not consume a real subscription or incur inference charges.

## Install the toolkit

Requirements: macOS or Linux, Python 3.10+, Git; Node 22.12+ to run plugin tests. No npm dependencies are needed for the offline tests. Inference additionally needs a compatible guarded OpenCode build and authentication
for each enabled provider: Codex CLI plus ChatGPT OAuth for OpenAI, or the separately
installed reviewed Claude Code OAuth adapter for Anthropic. Claude-only profiles do
not require Codex CLI. Installing the toolkit does not install either auth integration.

Download the source for the release you intend to install from this repository's Releases page, or check out its version tag. Review it, then run from the repository directory:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
python3 scripts/audit_public.py
python3 install.py install --source "$PWD"
```

Default installation: `~/.local/share/opencode-usage-harness`. The installer prints the installed version; it never edits shell startup files or starts a service. Add its bin directory yourself if desired:

```sh
export PATH="$HOME/.local/share/opencode-usage-harness/bin:$PATH"
harness-manage status
codex-quota --json  # OpenAI/Codex only
```

The `codex-quota` command above is for OpenAI users; Claude-only users should skip
it and use `subscription_quota` after enabling the Claude session integration.

`codex-quota` reads the existing Codex CLI login through `codex app-server --stdio`; it does not make an inference call. It preserves the distinction between missing telemetry and exhausted quota. Use `HARNESS_CODEX_BIN` for an absolute executable path when Codex is not on PATH.

For metrics, explicitly identify the compatible OpenCode database:

```sh
export HARNESS_OPENCODE_DB="/absolute/path/to/opencode.db"
harness-metrics --days 7
harness-metrics --days 7 --json
```

Preserve expensive check output privately with `harness-check --label tests --revision REV -- python3 -m pytest`. Each run keeps separate stdout, stderr and an exit-status receipt. Optional `harness-check --preview RECEIPT --stream stderr` returns a bounded page with exact repeated lines compacted; see [durable diagnostics](docs/TELEMETRY.md#release-gates-and-durable-diagnostics).

Progress guidance separates active execution from verified outcomes. When small work expands, agents revisit the next useful result; follow-up reviews carry existing findings forward and focus on affected changes. Checkpoint reminders are injected on existing primary model requests; they are cooperative guidance, not hard timeouts, new approval gates, or timer-driven model calls.

The database is opened read-only. The public repository includes no database. Historical permission-blocked minutes are unknown, and artifact freshness is not independently verified by the metrics tool. Completed checks are self-reported evidence, not proof of real-world correctness. Tokens are not subscription-dollar prices. For deduplicated completion counts and token totals across legacy logs and the new ledger, see [completion telemetry](docs/TELEMETRY.md).

## Enable agent integration separately

Read [COMPATIBILITY.md](docs/COMPATIBILITY.md) and [SETUP.md](docs/SETUP.md). The installer does **not** silently modify an existing OpenCode profile, choose account-specific model IDs, authenticate, buy credits, or install remote services.

The generated public profile asks approval for unknown shell commands, pushes, deployments, and destructive actions. Reasoned one-use large-file grants do not require a separate confirmation. Existing file permissions still apply. Your local preference for broader permissions can be configured explicitly.

For an explicitly authorized repository relocation, an operator can issue an expiring external-write grant to an existing worker. It is bound to the workspace, task, owner, intent revision, checks and destination. The dispatcher revalidates it on continuations and coordinates harness-managed destination ownership across workspaces; ordinary requests cannot grant themselves access by naming an absolute path. Native permissions still apply. This permits scoped destination work—it does not relocate sessions, copy files or approve publication automatically.

See [external write grants](docs/EXTERNAL-WRITE-GRANTS.md) for scoped cross-workspace migration, exact bindings, and the requirement to keep native/direct destination writers idle.

## Update and roll back

Obtain and review the new release source in a separate checkout/directory. Run tests, then:

```sh
harness-manage update --source /absolute/path/to/new-release
harness-manage status
# If needed:
harness-manage rollback
```

Updates use the new source's `VERSION`; changed content cannot replace an already-installed version. Files are staged, hashed, and activated through an atomic `current` symlink. `previous` retains a rollback target. State, OAuth credentials, project files, and active services are not updated or restarted. Source manifests detect local corruption; **they are not cryptographic publisher signatures**. Obtain releases from a trusted repository and verify release checksums.

Agent profiles refer to the release from which they were generated. Updating toolkit code alone does not switch active plugin paths. At a planned idle point, back up state, regenerate/review the profile with the new release's `configure.py --replace`, and explicitly restart the compatible service. Rollback of code does not roll back profile or state: restore the corresponding profile backup too. Do not downgrade a database schema blindly.

## Configuration and state

| Setting | Meaning |
|---|---|
| `HARNESS_STATE_DIR` | Mutable state; default `~/.local/state/opencode-usage-harness` |
| `HARNESS_OPENCODE_DB` | Required explicit compatible OpenCode SQLite database |
| `HARNESS_CODEX_BIN` | Optional Codex CLI executable; OpenAI only |
| `HARNESS_PYTHON` | Optional Python executable for plugin helpers |
| `CODEX_HOME` | Optional Codex configuration directory; OpenAI only |

Claude quota access resolves the selected OpenCode OAuth connection; it has no
parallel API-key environment setting.

Release code and state are separate. Never commit auth files, financial attestations, telemetry, chat histories, or state backups. See [security and limitations](SECURITY.md), [contributing](CONTRIBUTING.md), and [changelog](CHANGELOG.md).

## Acknowledgments

The large-file context control was inspired by Spotify’s [“Portal by Spotify cut my Claude Code token usage by 90%”](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90) and the [Shunt plugin in spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt).

Credit to Spotify for the approach of blocking broad reads of files over a 350-line threshold and delegating focused analysis to a smaller worker that returns a compact summary, while allowing targeted reads. This harness applies that approach to OpenCode with its own routing and quota controls. Spotify’s reported savings describe its experiments; they are not measured results for this project. No Spotify affiliation or endorsement is implied.

Headroom inspired our recoverable tool-result compression: the V2 harness now automatically compacts eligible new JSON, search listings, and repeated test/build output before they enter model context. Conservative [diff previews](docs/DIFF-PREVIEWS.md) retain all changes while shortening unchanged context; [diagnostics](docs/COMPRESSION-DIAGNOSTICS.md) explain skipped results, and [passive cache monitoring](docs/CACHE-DRIFT.md) detects prepared-context changes without rewriting requests. Every JSON row/value remains represented; exact originals are retained privately and can be read in bounded chunks through OpenCode's normal read tool. Nested CodeMode values, source reads, errors, permissions, and existing conversation history stay intact. No extra inference or proxy is required. We independently implemented these ideas after examining Headroom's [log compressor](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/crates/headroom-core/src/transforms/log_compressor.rs) and [compression store](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/headroom/cache/compression_store.py). See [automatic compression and retrieval](docs/CONTEXT-COMPRESSION.md), including limits and the local snapshot security boundary. Existing [bounded check-log previews](docs/TELEMETRY.md#bounded-log-previews) remain available.


## License

MIT. The OpenCode compatibility patch retains upstream attribution in `NOTICE` and `compat/LICENSE.opencode`.

### Reviewing efficiency on real work

Keep the default router and the native escape available while collecting ordinary
work. Use `harness-metrics --help` to select the relevant root chats and time
window, then compare direct-worker/native and routed tasks of similar scope.
Track user-accepted outcomes, corrections, elapsed time and validation evidence
alongside uncached input, cache reads and output. A reported completion is not
user acceptance, and token shares are not subscription quota shares. Do not
launch synthetic work just to evaluate routing. The provisional task-fit policy
stays neutral until reviewed task evidence supports a preference.

Anthropic usage-check failures now retain a sanitized reason (HTTP status, timeout,
network failure or invalid response) and bounded retry-after seconds when available.
Concurrent checks share the selected OAuth credential's private cache. Transient
failures may reuse disabled-overage verification only until the original successful
verification is 24 hours old; failures themselves never grant admission. Auth failures,
known exhaustion and expired financial evidence
remain blocking. This does not retry inference or switch accounts/providers. A stored expired
OAuth token tested outside the runtime is not proof that runtime refresh is broken.

Private runtime releases can be staged from public source with explicit,
hash-checked local adapters using `scripts/stage_private_release.py`. Source,
installed and verified-live are separate states. Configuration, policy, instructions
and launchers must be included in the verification manifest; see
[release procedure](docs/recovery-release.md). Historical telemetry directories
remain retained; reports covering the migration must account for both locations.

### Routine effort and measured compression

The example multi-pool policy selects Sonnet 5.5 **medium** for ordinary new
builder assignments, alongside the OpenAI medium-effort peer. High-effort roles
remain available for concrete complexity or risk. Validate model variants against
your own catalog. Existing worker routes and explicit overrides are preserved;
this policy change does not downgrade an admitted worker.

Compression reports distinguish deliberately protected tools from unsupported
formats and report observed skipped characters. `savings_status=no_observed_savings`
is a valid result: small outputs and source reads do not justify forced compression.
Prepared character reductions are not measured subscription-credit savings.

# Outcome-focused usage controls

These controls reduce avoidable orchestration and context work without treating
subscription tokens as API dollars. Financial admission, native permissions,
provider policy and the 350-line broad-read guard remain independent.

## Effective model selection

Every dispatch passes the selected role's current model reference to native
OpenCode, including continuations. OpenCode otherwise retains an existing child's
model even when the configured role changes. A dispatch `model` override persists
across that work key; `resetModel: true` returns to configured selection. A direct
UI model change observed after a known harness selection is retained as an override.
Legacy sessions lack override provenance: their next dispatch adopts the configured
role unless `model` is explicitly supplied. This does not rewrite running sessions
or the primary router's model.

Dispatch metadata and `task_dispatch_status` expose configured, selected and
previously observed model, selection source and quota pace. Selected means requested
from native execution, not proof of a completed model response; completion telemetry
is the evidence for actual inference.

Include `routing: {complexity: 'routine'|'standard'|'complex', risk: 'normal'|'high'}`
at meaningful handoffs. A cached quota read is used only at those boundaries.
When a reported window is over ten percentage points ahead of pace or has at most
10% remaining, explicitly routine/normal-risk builder or deep-debugger work may use
the quick-builder's configured model, within the same provider. Role permissions
and ownership stay unchanged. Missing/stale telemetry retains the configured
selection; the separate financial guard still denies inference when admission
cannot be established. High-risk work and explicit overrides are not demoted.
Behind-pace capacity does not automatically create work or reviews: the parent
can choose stronger reasoning where the expected improvement warrants it.

## Background completion and review

A native idle state alone does not complete a harness assignment. For newly
admitted background work, the parent can call `task_dispatch_collect` with the
recorded `taskId`, `workKey`, child `sessionID` and admission `generation`. This
read-only native inspection records a harness completion receipt only when the
exact dispatched prompt has a terminal visible answer and a successful idle
boundary. It does not send a prompt, resume inference or accept the overall task.

Pending input, newer execution, compaction, cancellation or failed execution must
not turn an older successful answer into the current result. Review admission
rechecks the collected generation before using it as author provenance. Existing
legacy background records without a generation binding cannot be retroactively
certified by this tool; inspect their evidence explicitly rather than redispatching
solely to obtain a completion flag. Status inspection never collects or starts work.

## Cumulative work and compact continuation

The cooperative ten-minute/30-model-step slice remains. It asks the worker to
give a concise progress update on the current execution; it never forces a return or kills tools. Lifetime
prepared-step and continuation counts survive redispatch. After 120 steps or six
continuations per work key, the next idle-worker admission requires
`workReview: {hypothesis, evidenceReference}`. The whole root/task also aggregates
all recorded lanes and requires reassessment after 240 steps or 12 continuations
since its last review. The parent supplies this from retained evidence; it is not
an additional human permission gate. Acknowledgment advances the review baseline,
not lifetime totals. These are model-step proxies, not token or financial budgets.
Legacy records initialize from their known current slice, not fabricated history.
Long uninterrupted runs still rely on cooperative checkpoint return; there is no
hard mid-request cancellation or guaranteed spending ceiling.

Context observations use the newest completed valid assistant usage after the
latest successful compaction. Input plus cache-read/write counters are included;
these are context measurements, not charged allowance. A streaming placeholder
cannot overwrite a valid observation with zero. Missing or invalid usage stays
unknown. The latest assistant identity remains independent for exact compaction
binding. The lookup scans at most 64 recent assistant messages.

Full and summary status expose `selfContext` for the caller and `context` for each
owned child, with observation identity/time, pressure and a safe next action.
The checkpoint status includes the same high-context advisory. High pressure and
compaction eligibility start at `min(absolute, 80% of the known window)` observed
input tokens, or at the absolute threshold when no window is known. The absolute
threshold defaults to 120,000 tokens and is configurable: `HARNESS_COMPACTION_TOKENS`
(environment, wins), else `configure.py --compaction-tokens N` (persisted as
`compaction_tokens` in `config/configure-choices.json`), else 120,000. A very large
window (for example 872k usable input tokens, whose 80% is ~698k) therefore no longer
defers pressure; status reports the effective `threshold` and `thresholdBasis`
(`absolute_tokens` or `window_ratio`). Before another substantial
continuation, collect current results, retain a concise checkpoint, then use
`compact:true` on the same child when `eligibleForCompaction` is true. Active tools
or descendants, pending admission, stale intent, denied work, an uncollected or
mismatched generation, and another responsible parent prevent that recommendation
from being ready. Context-pressure fields are advice, not new execution permission or a token-based
admission gate. Explicit compaction of a background execution must first preserve
its exact current-generation terminal receipt; compaction cannot erase uncollected
proof. A verified source-evidence snapshot survives an admitted compaction failure
for explicit same-child recovery. A missing or mismatched snapshot requires
inspection; a compaction-only generation is never relabeled as a task result.
Compaction cannot rebind stale intent: deliver the correction through the same
child first. A final completed task needs no compaction.

### Mid-run compaction of a running child

A long-running managed child no longer has to finish and be collected before it
can be compacted. When a running child's observed context reaches the trigger
above, the harness admits one native same-session compaction from the child's
own model-request preparation hook. OpenCode 2.0.30 queues it as a steered inbox
control and runs it only at the next step boundary: after the current model step
and all of its tool calls have settled, before the next model request. It never
runs mid-stream or while a tool call is pending. Additional gates: the record's
current generation is running with current intent and no denial or cancellation;
no explicit parent compaction is in progress (that compaction-wait lock wins);
native state shows the child active with no running tools and no active
descendants; only one mid-run compaction is pending at a time; a later one needs
a new completed observation after the previous compaction and growth of at least
a quarter of the trigger over the first post-compaction observation; a failed
compaction stops further attempts for that generation; at most 8 per generation
and 2 admission failures.

The native summary request receives the preserved assignment as system data: the
handoff brief (bounded copy), the `task_intent` continuation reference, recorded
check results, the latest checkpoint and the previous completion receipt. After the
compaction completes, every later model request of that generation carries the
same frozen continuation, so none of it depends on the summary keeping it.
Compaction IDs are derived from the generation's completion marker, and the
completion and terminal receipt readers accept exactly those compaction rows
inside the generation's chain. Any other compaction still invalidates the
receipt. If the step that admitted the compaction was the final answer, the
compaction runs after it; the receipt still binds that answer. Status shows
`midRunCompaction` (count, pending/last ID and status), never the brief.
`HARNESS_MID_RUN_COMPACTION=off` disables new mid-run admissions. Each compaction
is a model request against the provider's account-wide quota, which other agents
outside this harness also use.

Status never collects, compacts or resumes work. Explicit native same-session
compaction of an idle child must be admitted by the existing parent with the
retained checkpoint; its ordinary authorization still applies. Wait for the matching durable outcome
and idle state, then continue the same worker with refreshed full intent. Do not
interrupt tools, clone a worker, retry a failed compaction unchanged, or manufacture
work to obtain savings. Compaction consumes account-wide quota shared with agents
outside this harness. Root `selfContext` makes pressure visible without inventing
a cross-parent compaction route; only managed running children are compacted
mid-run, as described above.

Keep one bounded lane root → worker. Use a coordinator only for genuinely parallel
or multi-component integration. Batch intent/receipt bookkeeping at meaningful
changes, preserve passing checks, and send reviewers changed findings and evidence.

## Historical copies and migrations

Transcript copies are not interchangeable with the original worker tree. After a
migration, explicitly link a preserved copy to its canonical session:

```sh
harness-session-link --server http://127.0.0.1:3000 --api-base /api \
  --historical ses_example_copy --canonical ses_example_original \
  --token-file /private/path/to/client-token
# Inspect the dry-run result, then repeat with --apply.
```

The helper only accepts loopback servers, checks session identity/directory and
historical inactivity, saves a private metadata backup, and merges
`metadata.harnessMigration`. The token file must be private; credentials and chat
content are not emitted. Existing Basic server authentication can instead use
`OPENCODE_SERVER_PASSWORD` from a secure runtime environment. Never put it in a
shell command or repository.

Marked copies remain readable. Dispatch and model-request hooks reject execution
there and identify the canonical session. This does not merge transcripts, migrate
worker ownership, reparent children, or automatically resume the original. The
operator must carry over a concise context handoff and preserve original workers.
Quiesce submissions to the historical chat while applying the marker. The API
has no atomic idle/version precondition: inactivity checks are snapshots, and a
concurrent submission can still race the metadata PATCH. The helper rechecks
activity and metadata but does not claim atomic migration.
The marker is an operator-maintained recovery aid, not an adversarial security
boundary. Unmarked old copies cannot be identified reliably from title alone.

## What remains

Measure accepted outcomes and account-wide quota deltas over ordinary work before
claiming savings. Multi-provider live adapters and quota reservations remain future
work. Routing references are model-family-neutral, but the current live guard and
quota adapter remain ChatGPT OAuth/Codex-only. Native API integration needs the
required-plugin runtime patch; stock OpenCode is not certified by these unit tests.

## Capability validation and real denials

Match the assignment to tools before dispatch. `harness-reviewer`, scout and
architect are file-reading roles without shell execution. Requested tests or an
executable review require a shell-capable worker; preserve any explicit provider,
model and supported effort choice regardless of the worker role.

`TASK_DISPATCH_CAPABILITY_MISMATCH` identifies invalid role selection before this
call starts a child or attempts native execution. For a new, unadmitted assignment,
the parent may correct the role within the authorized scope and run the normal
admission path. Do not remove required capabilities or relax permissions. This is
not a recovery route around a previous denial: native permission, provider and
financial denials remain blocking, recorded owners retain their exact identity,
and continuing an existing child still requires its stored agent and parent.

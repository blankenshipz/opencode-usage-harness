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
collect the current operation and return evidence; it never kills tools. Lifetime
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

At a completed boundary, a worker whose observed last input context is at least
120,000 tokens receives an advisory. This includes cache-read input and is not a
measure of charged allowance. The parent can dispatch the same child with
`compact: true` and a retained `checkpoint` objective/evidence. It must be idle,
with no active descendants and new observed context. The harness invokes native
same-session compaction, retains ownership, and returns a compaction-pending status.
Admission alone is not completion: resumption waits for the matching durable
compaction outcome and idle state. The next continuation refreshes the full shared
intent. Compaction can use included inference; it is not free, automatic on every
turn, or implemented by cloning a worker. Native compaction failures require
inspection rather than repeated unchanged compaction calls.

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

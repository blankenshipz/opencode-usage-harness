# Bounded work and evidence-based continuation

The harness uses its existing dispatch registry, intent checks, denial recovery,
and native child completion. It adds no provider, polling loop, scheduler, or
approval form. Permissions, model selection, financial admission and ownership
remain with their existing controls.

## Keep the conversation responsive

`task_dispatch` and the wrapped native `subagent` default `implement`, `coordinate`
and `deploy` operations to native background jobs. Inspection remains foreground;
explicit `background: false` or `true` wins. Native completion resumes the parent,
which collects evidence and continues authorized work. This changes responsiveness,
not the amount of necessary work. Do not poll, duplicate workers or overlap writes.

Each continuation should target one next result. Keep the complete objective in
shared intent; pass only relevant checks and a bounded target:

```json
{
  "checkpoint": {
    "objective": "Capture the current startup failure",
    "expectedEvidence": "Retained exception and the first failed transition"
  }
}
```

Before expansion, agree one executable acceptance command and its input/output
contract with the producing worker and evaluator. Feature completion is separate
from delivery or publication: assign that work and its current gate explicitly.
A stale parked delivery assignment may resume only under current intent and a
current gate. Publication proceeds when authorized and its required gates pass;
this never grants approval or bypasses content-rights or review gates. Denials report the actor, action, and resource, leaving unrelated work
authorized; another route must not retry the denied action.

Queued instructions are delivery state, not proof that work started. At a meaningful
boundary, check the admitted child and generation plus fresh native activity before
sending another reminder. An idle background worker needs its exact result collected;
a stale intent or mismatched binding needs owner reconciliation, not repeated collection.
Status reports the structural collection blocker and whether that exact generation
already has a collected terminal receipt. It does not read new terminal evidence or
resume inference. A collected execution receipt is not project acceptance.

Across conversations, pass a compact artifact under existing read/write permissions:
producer revision and artifact hash, contract version, check receipt, intended consumer,
and unresolved differences. The consuming owner verifies that evidence and assigns its
own worker. This does not authorize cross-parent control or copying restricted data.
Agree canonical text, schemas, dependency setup and the producer/evaluator interface
through the executable acceptance command before broadening parallel work.

Git serialization protects actual shared metadata writes. Do not keep a conversational
Git hold after its owner is idle merely because feature work remains. Inspect current
ownership; an unknown or in-flight lease still requires reconciliation, not deletion.
Publication success needs a verified remote branch/commit or PR, not a local plan.

Except for explicit `publish` scopes, an admitted writer retains its `writePaths` through non-`deploy` operation
changes and implicit continuation of the same work key. A read-only continuation
becoming a writer must name paths explicitly; `[]` is rejected instead of falling
back to a workspace root, and conflicts identify the exact overlapping paths.

The field is optional for backward compatibility. Every newly admitted assignment
gets a cooperative slice: 10 minutes or 30 prepared primary model steps. On the
next existing primary context preparation, a stable reminder asks the worker to
report changed evidence and reassess scope while continuing useful authorized implementation and targeted verification. Return when the objective is verified, a real blocker prevents progress, or a changed approach is needed—not solely because a timer elapsed. No tool
is cancelled, no request is scheduled, and no worker is replaced. A running test
can exceed the budget. Preparation counts are not completed inference counts;
titles and compaction use separate hooks and are excluded. The reminder is guidance,
not a hard execution limit, and can only be delivered when another model step is
prepared. Existing in-flight legacy assignments acquire no slice until redispatch.

The slice persists in the ownership record; status reads do not advance it.
Explicit continuation starts another slice. A checkpoint is not whole-task
completion or a reason to ask for another user “continue.” Keep the same owner and
collect native completion. Once integration is underway, keep unrelated lanes quiet.

## Detect repeated work despite artifact churn

After two admitted continuations on the same intent/check binding without new
reported progress, handoff metadata and `task_dispatch_status` carry a convergence
advisory. Artifact revisions, freshness, wording, timestamps and operation changes
do not reset this semantic counter. A newly passed check counts once per binding;
pass/fail/pass oscillation alone is not new progress. A changed intent revision or
assigned-check set starts a new comparison. Polling and already-running returns do
not increment it; explicit steering does.

A checkpoint can report new evidence through `task_outcome.progressEvidence`:

```json
{
  "failureKey": "observer-closed-connection",
  "kind": "reproduced",
  "reference": "check-receipts/replay-17/receipt.json"
}
```

Kinds are `cause_eliminated`, `reproduced`, `check_passed`, and `no_change`.
Only a distinct positive report advances the evidence counter. Recent reports are
deduplicated by kind, failure key and reference; the last 32 digests are retained.
A reused reference outside that bounded history may count again. Keep references
stable for the same evidence. The registry retains bounded digests/counters; private
outcome telemetry retains the normalized report. Legacy receipt-change counters
remain available, but do not contradict newly reported semantic progress.

This is **self-reported evidence**, not proof of useful work or an automatic stop.
Inspect the actual receipt, change the diagnostic approach when attempts add no
information, and preserve unaffected passing checks. It never authorizes an action,
blocks permission evaluation, replaces a worker or adds an automatic review.

## Make human/device attempts useful

Before requesting a bounded live action, a bound worker may record
`task_outcome.attempt` with `phase: ready`, a unique ID, expected signal, a private
receipt reference, observed/expiry timestamps in milliseconds, and observed
readiness for receiver, observer and recorder. All three readiness fields must be
true. Check the actual components first; the harness does not perform those probes.
For a user action, use the existing blocked/needs_user_action outcome and return the
exact action promptly so the parent can surface it.

```json
{
  "id": "playback-17",
  "phase": "ready",
  "expectedSignal": "First receiver event or retained exception",
  "receipt": "check-receipts/playback-17/receipt.json",
  "observedAt": 1800000000000,
  "expiresAt": 1800000600000,
  "readiness": { "receiver": true, "observer": true, "recorder": true }
}
```

On continuation, record `captured`, `failed`, or `expired` for that same ID with
`observedAt` and compact evidence; `failureKey` is optional. Readiness cannot be
extended or reopened using the same ID. A terminal report must match a known
attempt. A captured/failed event observed before the deadline can be reported late;
status labels delayed reporting. Future observations and stale transitions are
rejected. A new ready ID can replace a terminal or expired attempt. Only the latest
attempt is held in the registry; outcome telemetry retains earlier reports.

Status calculates expiry without a timer or inference call and labels every
attempt `selfReported: true`, `livenessVerified: false`. Expiry changes metadata
only: it does not shut down a receiver or service. An expired capture must not be
reported as a running test. Inspect retained diagnostics before asking for another
human action; repair a broken recorder or reproduce offline when possible.
Application test cleanup should preserve normal discovery where its safety design
permits. The harness cannot repair a device application's cleanup behavior itself.

Attempts belong to a bound worker and intent revision, survive registry reload,
and appear in `task_dispatch_status.owners[].verificationAttempt`. A rejected
outcome does not mutate their lifecycle. Old clients can omit this optional field;
they do not gain a readiness guarantee. Human waits still appear in `userActions`;
no new push-notification transport is introduced.

## Verification and limits

Offline fixtures cover background defaults and explicit overrides, single-owner
resumption, cooperative boundary injection, legacy state, artifact churn, evidence
deduplication, attempt persistence/expiry, stale results and unchanged financial and
permission gates. The primary-context and native-background APIs were checked
against the pinned 2.0.18 source. No live inference was used for these tests.

Measure time to a useful result, repeated live attempts, and repeated checks under
ordinary work. These controls do not establish a performance improvement until a
real workload is observed. Large contexts should be compacted selectively at phase
boundaries with current ownership, authorization, evidence and failure identity
preserved; no timer-based history rewriting is added.

For routine decision boundaries use `task_dispatch_status({taskId, summary:true})`. It retains exact generation, collection, compaction and recovery identifiers without repeating full ownership history or receipts. Omit `summary` only to investigate a specific missing detail. Neither view starts work.

### Remaining coordination limitation

Compaction outcome is reconciled when dispatch/status observes the native record.
There is no guaranteed durable parent notification for every compaction completion.
The parent must observe the matching compaction ID and continue the same child when
authorized. Status inspection never starts work. A future notification outbox would
need exact parent/generation binding, restart-safe deduplication and explicit
non-resuming delivery; automatic worker wake-ups are not implemented.

Capability discovery is distinct from permission admission. A verifier can have
artifact-only edit capability while retaining a blanket production-file deny.
The dispatcher must recognize that scoped capability; the native executor still
checks each actual path and secret restriction. A missing capability on an existing
assignment must identify that capability, not falsely report a changed child identity.
Preserve the existing child, role and real denial history during correction.

### Publication is distinct from deployment

Use `publish` only for authorized publication of an already-frozen Git commit.
Every admission requires `publication: {revision: "<full commit OID>", checkout: "<workspace-relative checkout>"}` and
explicit nonempty `writePaths`, even for the same child. Admission discovers the
actual checkout root and shared Git metadata with read-only Git queries and always
reserves both. Include every additional hook/output path involved in `writePaths`.
Missing/invalid Git discovery or external metadata fails closed.
Push the exact OID to the approved ref, non-force, preserving native command
approvals, hooks and required gates. Do not silently skip hooks or relabel a real
permission denial. The binding records intent; it does not parse or sandbox shell
commands or prove the remote accepted the commit. Confirm the remote afterward.

Disjoint worktrees need not wait for a whole-checkout deployment lease. Shared Git
metadata and overlapping checkout/output paths still serialize. Unknown hook
effects require broad scope and waiting for its owners. `deploy` retains exclusive
workspace ownership; source changes/builds are separate implementation or verification
work. Never clear another active worker's lease to publish. A dispatcher rooted in
a linked worktree cannot silently omit an external common Git directory: the
minimal publication path does not add new external-write grants. Use an already
authorized workspace containing the Git metadata or stop for an operator-supported
solution; changing workspace must preserve ownership through normal reconciliation.

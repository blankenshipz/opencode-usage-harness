# Finish the user journey with less repeated work

The harness reuses its existing dispatch registry, intent checks, denial recovery,
and native child completion. It adds no model, provider, polling loop, approval
form, or separate orchestration service.

After three admitted dispatches on one work key without a changed assigned-check
receipt, the worker handoff and dispatch metadata carry a convergence advisory.
`task_dispatch_status` exposes the same advisory. It asks for the concrete failure
or last artifact/checkpoint and one next action for the same owner. It never blocks
admission, replaces a worker, adds review, or declares a stall automatically.
Status polling and already-running returns do not increment the counter. Explicit
steering of an active child is an admission and does count.

Receipt status, verification mode, freshness and artifact identity/generation are
compared in canonical check-ID order. Intent, assigned checks or operation changes
reset the counter; changing prose or timestamps does not. Only a digest and bounded
counter are persisted. This is **missing recorded progress**, not measured wasted
work: code changes without receipts can legitimately trigger the advisory. Old
registry entries begin counting on their next admission.

Once implementation converges, one existing integration/deployment owner carries
it through the user-facing test. Unrelated lanes stay quiet. A concrete failure can
reopen the relevant specialist, while unaffected passing checks remain valid. This
is routing guidance layered on existing ownership enforcement, not a new lock.

Workers waiting for a human/device action record an existing blocked checkpoint
with `progressState: needs_user_action` and `blocker.nextAction`, then return that
action to the parent. Status exposes `userActions` for current intent bindings with
worker/task identity, time, and explicitly self-reported provenance. A later
checkpoint clears that worker's attention state. Admission alone does not clear it.
Keep secrets out of nextAction as with all receipts.

Parents surface the action at native completion or their next status check instead
of reporting only “active.” There is no new push-notification transport: a silent
worker that never records its wait cannot be inferred to need user action.

Evaluate with ordinary work: time to a usable outcome, admissions without changed
receipts, corrections and relevant check reruns. These diagnostics neither prove
subscription savings nor replace required safety/security verification.

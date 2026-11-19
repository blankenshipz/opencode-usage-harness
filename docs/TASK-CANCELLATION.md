# Cancelling a dispatched child

`task_dispatch_cancel` lets a delegating role (router or coordinator) stop a
child that it dispatched itself. A typical case: the operator changes the rules
while a child holds a workspace-wide writer lease, and the parent needs to admit
a different lane.

```
task_dispatch_cancel {taskId, workKey, reason}       // or sessionID instead of / with workKey
```

`reason` is required and limited to 500 characters.

## Who may cancel

- Only the session recorded as the child's dispatcher (`parentID` in the
  ownership record), and the child must also be its native child.
- A grandchild is refused unless the caller dispatched it. Ask the coordinator
  that owns it to cancel it, or cancel that coordinator, which cancels its
  records as well.
- Children in other task trees, historical transcript copies, and ambiguous
  selectors (several records match) are refused.

## What it does

1. Rejects every pending permission ask in the child's session subtree through
   `permission.list` / `permission.reply` with `decision:'reject'`. No feedback
   message is sent: a plain rejection ends the step, while a rejection with a
   message would return an error to the model, which could then keep working.
2. Interrupts the child, then each of its active descendants, with
   `session.interrupt({sessionID, resume:false})`. That is the OpenCode 2.0.30
   plugin API. `resume:false` keeps queued input from restarting the session.
   Any asks raised in the meantime are swept a second time.
3. Revalidates the exact record (same key, child and generation) under the
   global writer lock and then the workspace ownership lock. It then records
   `state:'cancelled'` and
   `cancellation {generation, reason, cancelledAt, cancelledBy, previousState, interrupted, interruptFailures, pendingPermissionsRejected, permissionCleanup, releasedWritePaths}`.
   It clears the record's `writePaths` and removes the global writer leases held
   by the child or its descendants. Records that the child dispatched are marked
   cancelled with `cascadeFrom`.

The result reports `status`, the interrupted sessions, the number of rejected
asks, and `releasedLocks`.

Native calls run outside the registry locks, so an interrupt never waits on a
hook that needs those locks.

## Idempotency and failure

- If the child is already cancelled, the result is `already_cancelled` with the
  original cancellation record.
- If the child and its descendants are idle, the result is `already_finished`
  and nothing changes. An idle child holds no admission lock; use
  `task_dispatch_collect` or `task_dispatch_reconcile_terminal` for its result.
- If the record has no child yet, the result is `not_started`. If its admission
  is still in flight, the call is refused; retry once status shows a child.
- If interrupting the child itself fails, nothing is recorded and no lock is
  released. Failed interrupts of descendants are listed in
  `interruptFailures`.
- If the runtime exposes no permission API, the result reports
  `permissionCleanup:'unavailable'`.

## After cancellation

- The cancelled child and its descendants cannot start a model request until
  the parent re-admits the child through `task_dispatch` with its `sessionID`.
  Its write scope was cleared, so a write-capable continuation must pass
  explicit `writePaths`.
- A replacement lane normally uses a new `workKey`.
- A foreground handoff that is cancelled mid-flight returns whatever the native
  call returns, and the cancellation stays on the record.
- `task_dispatch_status` shows `recordedState:'cancelled'` with `cancellation`
  for each owner, and a top-level `cancelledChildren` list.

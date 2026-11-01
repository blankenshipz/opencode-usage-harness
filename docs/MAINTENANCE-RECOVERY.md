# Completion evidence after operator maintenance

A worker can finish useful work after an approved maintenance pause while its
original background-dispatch receipt remains unavailable. The receipt reader
correctly rejects an aborted assistant, interrupted idle and later user message
as an uninterrupted completion chain. Idle status, preserved commits and passing
tests alone do not repair that binding. Do not rerun implementation to manufacture
a receipt, clear the failure flag or mark the worker completed without evidence.

Maintenance operators should preserve the exact current assignment and completion
binding before interrupting a worker, together with interruption acknowledgements
and stable continuation IDs. Prefer a normal same-worker harness continuation
with a new admission binding when that is supported; do not replay an uncertain
control or invent continuation authority.

For already completed work after an explicitly authorized maintenance continuation,
a narrowly audited **administrative maintenance reassociation** is possible:

1. Verify the exact root, parent, child, task, work key, generation, current intent,
   role and model. Require no admission in flight, prior completion receipt,
   active child/descendant, pending input or current compaction.
2. Verify the unique original prompt by marker and full hash. Follow native
   evidence through the exact aborted assistant, interrupted idle and exact
   maintenance continuation ID/hash, without another user prompt, compaction or
   identity switch. Match the independent operator pause/resume receipts.
3. Pin the resumed final assistant and successful idle IDs/sequences. Require
   the unchanged strict completion reader to validate the maintenance prompt
   through that final answer. Missing evidence requires investigation, not repair.
4. Under the existing registry lock, compare the original binding and assignment
   again. Back up state; retain the full original binding, original prompt and
   interruption IDs, continuation ID/hash and operator evidence in a recovery
   audit. Rebind only the completion boundary to the actual maintenance prompt.
   The ownership admission generation can stay unchanged.
5. Collect through the ordinary parent tool. If an operator also records
   collection, reproduce every collection guard and store only the native
   reader's receipt. Recheck the native boundary immediately before saving and
   revalidate afterward. Preserve ownership, scopes, models, permissions,
   financial settings and native messages. Never restore delivered-operation
   ledgers during rollback.

This receipt proves the **maintenance continuation → final answer → successful
idle** leg. The original bridge is administrative evidence, not an uninterrupted
native chain. Registry locking does not make native execution and registry state
atomic. An identical completed repair should be inspected and revalidated rather
than blindly reapplied; changed evidence must fail closed.

This is an operator procedure, not a model-callable grant writer or a new review
waiver. The independent review remains outstanding until it actually runs.

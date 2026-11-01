# Stopped-generation reconciliation

A correction intentionally blocks an old worker from further inference until its
parent explicitly rebinds it. That execution guard remains unchanged. A stopped
generation can nevertheless have useful terminal evidence to archive without
running it again.

The recorded parent may call:

```json
{"taskId":"release","workKey":"backend","sessionID":"<recorded child>","generation":7}
```

using `task_dispatch_reconcile_terminal`. Status exposes the action and boundary
eligibility; eligibility is not proof that a native terminal receipt exists.
Status does not perform terminal reconciliation.

The tool requires the exact parent, task, work key, child, generation and matching
background binding. Native role/model identity must match; the child and every
descendant must be inactive, with no admission in flight. The read-only native
reader matches one exact marked prompt and its hash, rejects pending inputs and
later execution boundaries, and requires an explicit final native terminal idle.
Idle alone without the admitted prompt is insufficient. Successful terminal chains
also require a nonblank successful stop response. A failed model-request gate can
have a failed terminal idle without creating a final assistant response.

The result is `settled`, with native `succeeded`, `failed`, or `interrupted`
evidence, and always `acceptedForCurrentIntent:false`. Successful current-intent
generations still use `task_dispatch_collect`. Reconciliation never records check
success, certifies a review author, clears permission/provider denials, grants a
scope, sends a message, retries inference, or replaces a worker.

Global and workspace registry locks use the same order as admission. Native
identity and receipt are reobserved before recording the settlement; native
execution and registry files are not one atomic database transaction. Only the
matching inactive global write reservation is released. A partial global-release
failure can be reconciled idempotently using the same IDs. The current settlement
and up to 16 historical settlements persist across restart; a new admission gets
a new generation and clears only the current-settlement pointer. Legacy/unbound
or ambiguous native history remains unverified, not silently certified.

Only IDs, native outcome, sequence numbers and available timestamps are retained;
result text, reasoning and provider error bodies are not copied into settlements.
Known native provider-recovery chains require the existing strict retry proof,
canonical recovery marker and unchanged assistant identity, with at most eight
recoveries. Unsupported terminal histories fail closed rather than being guessed.

# Root progress updates

An active managed root router/coordinator uses native execution start and its
latest completed visible text to assess ten minutes of silence. A stable reminder
is added only to an already occurring context preparation. It does not start a
request, wake an idle root, alter quota/routing, impose a new review gate or force
a return. Actual visible text resets the advisory; malformed/future or missing
execution timestamps cannot fabricate pressure. Native agents and historical
transcript copies retain their existing behavior. This is cooperative guidance,
not a guarantee that a provider will emit text on a fixed schedule.

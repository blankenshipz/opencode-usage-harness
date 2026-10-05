# Completion telemetry

Completion events can reach more than one plugin instance. New completion records
are stored once in `telemetry/completions.sqlite3` beneath `HARNESS_STATE_DIR`, keyed
by session ID and assistant message ID. SQLite enforces uniqueness across concurrent
listeners and restarts. The writer uses Python's standard `sqlite3` module through
a bounded asynchronous subprocess; no extra Python package is required.

Existing `completions.jsonl` files are preserved. New completions are not appended
to that legacy stream. To summarize both sources without counting repeated events:

```sh
node "$HOME/.local/share/opencode-usage-harness/current/bin/completion-telemetry-report.mjs" \
  "$HARNESS_STATE_DIR/telemetry/completions.jsonl"
```

The optional second argument selects a different ledger path. Otherwise it uses
`completions.sqlite3` beside the supplied JSONL path. A missing JSONL file is valid
on a fresh installation. Malformed lines are counted and skipped. The report
returns unique completion counts and token totals; it emits no prompt/tool text.
When both sources have the same identity, the canonical ledger record wins.

Token totals are not subscription-dollar costs. The report does not prove task
acceptance or attribute account-wide quota changes to a particular chat.
`harness-metrics` continues reading the session database for workload-level metrics;
it does not sum the legacy completion stream.

Telemetry is best effort: a failed write is retried once, then logged without raw
provider or subprocess output. Later completions still record. A crash before a
completion is persisted can leave a gap; uniqueness is not a promise of lossless
event delivery. Reloading a plugin during an already-started model step may also
miss that step's completion. Use the session database to investigate missing records.

Deploying changed plugins requires updating any locally maintained release-integrity
manifest. Preserve the existing financial guard and use a planned reload compatible
with your runtime; do not bypass required-plugin checks to make a plugin load.

## Worker progress in OpenChamber

Foreground `task_dispatch` waits now publish a rate-limited activity summary to
the parent tool card: active worker tool or an observed blocked state. The direct
subagent card consumes `summary`; delegation inside `execute` uses `toolCalls`.
These are the existing rendering surfaces in OpenChamber 2.0.3. No additional
model call is made, and raw prompts, tool arguments, outputs, and errors are not
forwarded into the activity summary.

A quiet parent is not proof of a stalled worker. The indicator reports observed
events, not a watchdog guarantee, and a long-running tool may be legitimately
quiet. Background dispatch returns immediately, so its settled parent card does
not receive this foreground tracker; open the native child session for status.
Already-running dispatch calls retain their existing code until they settle;
the new tracker attaches to subsequent calls after plugin reload.

Agent instructions request concise milestones at natural boundaries, aiming for
roughly five minutes when meaningful progress occurs, with blockers/questions sooner,
and a heads-up before long blocking calls.
This is a communication target, not a timer guarantee: a waiting parent cannot
produce prose until its foreground call returns. Workers' prose remains in their
own sessions. The parent card also shows observed reasoning/responding phases
from start/end events; no reasoning content or text deltas are forwarded. There
is no artificial heartbeat, polling loop, or additional inference for narration.

## Reconnecting to a running worker

The task-outcomes plugin now saves sanitized progress snapshots under
`HARNESS_STATE_DIR/progress-snapshots`. Each snapshot binds an exact parent session,
message, and tool call to its child, including reused older children. It retains
observed activity, reasoning/responding phase, blocked state, and observation time;
it never stores raw tool input/output, assistant prose, or reasoning content.
Terminal events close snapshots. A restored snapshot is **last observed**, not a
heartbeat or proof that the worker is still alive. Checkpoints and the next action
remain in shared task evidence and compact continuation assignments, not inferred
from a tool label.

OpenChamber 2.0.3 needs the optional adapter to restore those snapshots when loading
messages. Install it against your existing authenticated OpenChamber instance:

```sh
python3 integrations/openchamber/install-progress.py \
  --web-root /path/to/node_modules/@openchamber/web \
  --snapshot-dir "$HARNESS_STATE_DIR/progress-snapshots"
```

This backs up the proxy file and adds an authorized message-response overlay. It
does not change authentication, listen addresses, providers, or model requests.
Restart only the OpenChamber web process to load the adapter; preserve the attached
OpenCode service. Other OpenChamber versions fail the installer compatibility check.
Restore the printed proxy backup to remove the adapter. Reapply after an upstream
OpenChamber update only after validating compatibility. The adapter imports this
harness checkout, so keep it in place until uninstalling/reapplying the adapter.
Existing foreground calls can populate snapshots on their next progress event;
a call with no observed event has no reconstructed status. Corrupt/missing snapshots
leave ordinary message rendering unchanged. No periodic model calls are added.

## Handoffs and edit recovery

A new child, changed intent revision/check assignment, or `refreshIntent: true`
receives full intent. An acknowledged same-child continuation receives a compact
reference plus the parent's next action. After context loss, workers must read
`task_intent`; explicit refresh is available when needed. Failed delivery is not
acknowledged. Assignment authority remains revision checked throughout execution.

The edit-recovery wrapper blocks identical deterministic patch failures within a
session. Changed patch text or changed target metadata permits a new native attempt;
malformed patch syntax requires corrected text. Permission/network/timeouts remain
native errors, not cached denials. The bounded memory-only cache stores hashes and
file metadata, not raw patch bodies. This is an efficiency aid, not authorization.
Agent guidance also requires path discovery and refreshed context after mismatches.

Broad fan-out uses a user-facing acceptance table linked to existing intent checks,
with journey, components, owner, evidence, and prerequisites. Scope changes identify
affected rows/workers and preserve valid earlier results. This planning behavior is
instruction guided; it is not a new permission or approval gate.

## Occasional worker milestone notices

The task-outcomes plugin saves a separate, bounded milestone store. Valid child
checkpoints become compact **Worker-reported update** notices in the root chat.
Routine changes are combined within a five-minute window; blockers and requests
for input can surface sooner, with a one-minute limit against bursts. Identical
reports are suppressed. The first meaningful checkpoint can appear immediately.
No checkpoint means no invented heartbeat. These are self-reported checks, not
independent verification or proof that the overall task is complete.

Only check identifiers/statuses and a closed set of role/blocker labels are
included. Raw evidence, prompts, tool output and reasoning are excluded. Notices
are delivered through the authenticated OpenChamber message overlay and SSE stream,
never inserted into OpenCode history, the model context, or a worker inbox. Reading
the store and delivering notices uses no additional model inference. Reconnects
restore recent notices; native pagination cursors remain unchanged.

The server adapter and matching UI patch are both required for timeline display.
For an existing v1 server adapter, use the installation command above with
`--upgrade`. Unknown adapter versions are rejected. Back up the UI assets before
installing a build from the exact OpenChamber 2.0.3 source tag:

```sh
git apply /path/to/opencode-usage-harness/integrations/openchamber/milestone-ui.patch
bun install --frozen-lockfile --ignore-scripts
bun run --cwd packages/sdk build
bun run --cwd packages/ui type-check
bun run --cwd packages/web build
```

Use the upstream-supported build toolchain and deploy `packages/web/dist` to the
web package's `dist`, preserving old hashed assets for already-open browser tabs.
Restart the web service and refresh the browser. Rollback requires restoring both
proxy and UI backups. An upstream update requires compatibility review and a new
build; this is an opt-in integration, not an automatic upstream patch.

Hosted mobile browsers use the same web UI. An already-installed native iOS app
bundles its own UI and requires a matching mobile build/update to show these new
notices. Updating server assets alone does not update that app. Existing worker
activity cards remain available independently of the new timeline notices.

## Dependency and recovery reporting

`task_outcome` optionally accepts `progressState`: `working`, `waiting_dependency`,
or `needs_user_action`. Working and waiting require `status: in_progress`; waiting
also requires 1–8 distinct `dependencySessionIDs` excluding the recording session.
These are self-reported dependency references, not independently verified liveness.
User action requires `status: blocked` with the existing blocker evidence/next action.
Completion still requires the original check receipts; no status label bypasses it.
Legacy callers remain compatible. Waiting updates and implementation-gap reports
use the routine five-minute digest; explicit user action can surface sooner.

Journal guidance batches updates at meaningful check, dependency, scope and handoff
changes. One canonical blocker entry avoids repeatedly rewriting several documents.
After a patch mismatch, refresh the exact section before a smaller corrected patch.
This is guidance, not a new write restriction or a ban on requested documentation.

### Scoped denial receipts

Dispatch records explicit native subagent permission denials and the observed
`misalignment_policy_violation` provider failure under the existing root/task/work
identity. The receipt persists only category, fingerprints and observation time.
`task_dispatch_status` exposes a safe category and recovery action. Ordinary child
prose, test failures, network errors and unavailable quota telemetry are not denial
signals. Receipts start with newly observed failures; historical chats are not
reclassified automatically.

An unchanged denied assignment is not sent again merely because its prompt, model
or time changed. A distinct authorized assignment remains eligible. A retry may
supply `recovery` with `kind` (`scope_changed`, `inputs_changed` or
`authorization_changed`), `scope`, `inputs` (a short list), `authorization`,
`explanation`, and a non-secret `reference` to the new evidence. A repeated
recovery fingerprint is suppressed; changing only its explanation is insufficient.
The evidence is a caller declaration, not independently verified approval. It
permits another native evaluation and never overrides native permissions, provider
policy, ownership, quota admission or financial controls. Do not put secrets in
these fields: the new receipt hashes them, but ordinary tool-call history still
contains the caller's arguments. Never rename the work key to retry a denied effect.

A denial of one file/batch is not proof that every edit is forbidden. Capture the
actual action/resources and available native identifiers once; leave unavailable
rule/issuer details explicitly unknown. Continue unrelated authorized work through
normal checks. A known denial must not be evaded using another tool or worker.

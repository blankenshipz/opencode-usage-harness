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

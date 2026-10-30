# Compression diagnostics

The V2 compression hook writes best-effort local diagnostics to
`$HARNESS_STATE_DIR/telemetry/compression-diagnostics.jsonl`. The stream is
metadata only: it contains a timestamp, session identifier, event type, skip
reason, local processing duration, character counts, and strategy when one was
prepared. It never records tool input, output, prompts, paths, snapshot
references, commands, secrets, model routing data, or provider usage.

Each record has `version: 1`. `candidate` records use a reason such as
`prepared`, `unsupported_tool`, `below_minimum`, `input_over_budget`,
`no_useful_projection`, `no_net_saving`, `store_busy`, `store_record_limit`,
`store_byte_limit`, `disk_reserve`, `projection_over_budget`, `store_not_published`,
or `processing_failed`. A `native_original_retrieval` record is emitted when a
native `read` call successfully reads a `chunks.jsonl` or `original.txt` artifact
at the configured store path. It is an observed call count, not evidence that
the whole original was read or used by a model. It covers persisted snapshots
after restarts without recording their paths.

`processing_ms` is local elapsed time for the observed block through projection
and optional snapshot publication (including classification on the first block),
or classification time for an excluded tool. Multiple blocks do not re-count
previous blocks' processing time. Diagnostics append asynchronously and failures, capacity
limits, unavailable observers, or malformed telemetry only reduce measurement
coverage; they do not change tool output, snapshots, inference, billing, or
compression admission. A serialized queue accepts at most 256 pending records.
The current 2 MiB file rotates to `.1` when full, retaining only the current
file and one predecessor; older diagnostics are intentionally discarded so a
long-lived runtime can continue observing later traffic without unbounded
storage.

No token estimate is produced. The diagnostic record and `harness-metrics`
explicitly report `token_estimate.status: unavailable` because the shared hook
does not select a tokenizer from a guessed model/provider mapping and adds no
tokenizer dependency. Character reduction remains separate from token, credit,
or dollar savings.

`harness-metrics` reads this stream only within the requested session/time
scope. Its `context_compression` object preserves the existing prepared-result
fields and adds `diagnostics_status` (missing evidence is unavailable), `skipped_reasons`, `processing_overhead_ms`,
`native_original_retrievals`, `token_estimate`, and
`invalid_diagnostic_records`, plus the bounded `diagnostics_retention` value.
The metrics reader reads the current file and `.1`, and does not open originals
or chunk files.

Protected source/edit/control tools now report `protected_tool`, separately from
`unsupported_tool`. `skipped_observed_chars` aggregates available bounded text
lengths by reason; absent lengths are unknown, not evidence of zero output.
`savings_status` explicitly reports no observed savings when no projection was
prepared. These counters never contain source, prompts, paths or model tokens.
Use actual coverage to choose future transforms; do not lower safety thresholds
or compress protected reads just to produce a positive savings number.

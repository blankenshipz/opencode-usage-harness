# Passive context/cache monitoring

`task-outcomes` installs `installCacheDrift` on the native V2 `session.context`
hook for every model family. It observes the shared, prepared model context;
it does **not** intercept HTTP/WebSocket traffic, inspect authentication, change
cache headers, reorder tools, rewrite messages, or perform inference.

Each session keeps a bounded in-memory baseline for instructions, ordered tool
definitions and up to three early messages. The last message is excluded because
it can still be growing. Append-only history is normal. Switching agent, model or
variant, shortening history, or crossing an attempted compaction boundary resets
the baseline with a separate reason instead of reporting unexplained drift.
Changes within comparable contexts identify `system`, `tools`, or
`early_messages`. Instruction/tool changes may be legitimate configuration
updates: **drift is not proof of a cache miss, excessive spending, or a bug**.

Objects are canonicalized for hashing; tool order is preserved. Known part-level
cache hints and provider metadata are ignored without stripping similarly named
fields from opaque tool data. Only HMAC fingerprints remain in memory, with a
random per-observer key. No fingerprints, prompts, tool schemas, message content,
provider state, credentials or headers are written to telemetry.

The observer keeps at most 128 sessions and bounds each fingerprint traversal
by size, node count and depth. Oversized/unsupported input reports
`observation_unavailable`; errors never block model admission. Reloads start fresh
baselines. Contexts that bypass this native hook are not covered. Later hooks and
provider serialization can still change wire bytes, so this is intentionally a
prepared-context diagnostic, not an exact provider prefix-cache monitor.

Records in `$HARNESS_STATE_DIR/telemetry/cache-drift.jsonl` contain session ID,
timestamp, reason, changed dimensions and processing time. The best-effort queue
is capped at 256 events, flushed in batches, and rotates at approximately
16 MiB, retaining one previous segment (one batch may cross the limit). Queue/storage loss can be reported on a
later successful batch; abrupt shutdown can lose pending observations. No raw
content is logged. Files are private; old diagnostic segments expire on rotation,
but original tool snapshots are never removed by this observer. No model calls occur.

`harness-metrics` exposes `cache_drift` per root workload and distinguishes missing
telemetry from no observations. Compare these observations with its existing
provider-reported cache-read/cache-write token counters; don't infer dollars or
causal savings from fingerprint changes alone. Subscription admission stays in
the separate provider guard.

Independently inspired by Headroom's [drift detector](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/crates/headroom-proxy/src/cache_stabilization/drift_detector.rs).

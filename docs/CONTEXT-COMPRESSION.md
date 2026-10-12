# Recoverable context compression

The V2 task-outcomes plugin installs automatic compression of **new local tool
results** through OpenCode's `tool.execute.after` hook. Installation and updates
use the existing harness plugin distribution; no extra dependency, provider,
proxy, model call, or agent opt-in is needed. Runtimes without this hook keep their
native results. Legacy V1 does not implement automatic compression.

## Model-family independence

Compression is shared OpenCode middleware, not part of the Codex adapter. It
operates on native tool-result text before provider message serialization and
uses no model IDs, reasoning variants, inference APIs, authentication, quota
telemetry or provider tokenizer. The same eligible result receives the same
projection whether the eventual model is Codex, Claude, Gemini, a local model,
or a future family. This is a runtime contract, not a claim of live testing or
subscription support for those providers.

When adding a provider:

1. Keep `installContextCompression` installed once in the shared V2 tool path
   (currently through `task-outcomes`); do not duplicate it in provider adapters.
2. Preserve its projected content, retrieval marker, structured tool output and
   native read permissions through the provider's message conversion. Run the
   hook regression tests and a real tool/retrieval smoke test for that adapter.
3. Reuse the generic retrieval guidance from `config/instructions.json`; replace
   the **separate Codex-specific financial/routing policy** with that provider's
   tested admission and quota adapter. Do not copy the entire current profile
   blindly or merely expand its allowlist.
4. Measure actual token usage and retrieval quality per family. Character savings
   are not universal token savings; tokenization and prompt caching differ. A
   future token estimator belongs behind a model-specific metrics interface,
   not inside the lossless transformation or billing guard.

The current live profile still enables only OpenAI with its existing safeguards.
Provider-hosted tools that bypass OpenCode's local tool hooks need a separately
validated integration; shared compression cannot cover that path automatically.
See the [subscription adapter contract](SUBSCRIPTION-POOLS.md#adapter-contract-before-enabling-a-provider).

See also [compression diagnostics](COMPRESSION-DIAGNOSTICS.md), [passive cache monitoring](CACHE-DRIFT.md), and [conservative diff previews](DIFF-PREVIEWS.md).

## What it does

- JSON whitespace removal preserves raw numbers, escaped strings and duplicate
  keys. Rectangular arrays become explicit columns + rows, retaining every row
  and value in order. It never samples or summarizes away records.
- Plain grep/glob path lists can share a common directory prefix, retaining every
  suffix and match. Outputs not matching that format pass through.
- Recognized simple test/build shell commands can collapse **exact consecutive**
  repeated lines with explicit counts and source line ranges. Distinct errors,
  timestamps, paths and numbers are not normalized. Other shell results and the
  outer CodeMode `execute` result are eligible only for JSON transformations.
- Large plain Git diffs can omit surplus unchanged context with explicit markers, retaining every file, hunk and change. These are labeled non-applyable previews; originals remain available.
- Only model-facing text changes. Structured `.output`, metadata/exit status,
  file/image blocks and nested CodeMode fallback text remain native. Direct
  source reads, edits, patches, unknown tools and harness control tools are
  excluded. Recognized native MCP registrations receive JSON-only compression. Provider-hosted and background completion results are not covered.

Candidates must be 4,096 characters to 1 MiB of UTF-8, and save at least 512
characters and 15%, **including retrieval instructions**. Projected text must
fit within 24 KiB and 1,500 lines. Oversized, malformed, unprofitable or failed
candidates pass through unchanged; native OpenCode truncation still applies.
No claim is made that fewer characters always means proportionally fewer tokens.

## Originals and bounded retrieval

Before publishing a projection the harness atomically stores:

- `original.txt`: exact UTF-8 output received by this hook.
- `chunks.jsonl`: the same text divided into JSON strings, one per line. Join
  decoded strings in order (strip native read's `N: ` line prefixes and ignore
  its header/footer first) to reconstruct the exact original. Each serialized
  line is at most 1,800 code units, below native read's line clamp.
- `metadata.json`: digest, strategy, session identifier, timestamp and character
  counts, with no command, prompt or output text.

These private artifacts live under `$HARNESS_STATE_DIR/tool-output-store` (the
normal harness state directory by default), in 0700 directories and 0600 files.
A stable reference incorporates the originating call, block and content digest.
The marker supplies the exact path. Use **native read** with `offset=1, limit=3`
initially; advance the line offset only if necessary. Native read approvals,
external-directory permissions and the harness large-file guard still apply.
There is no custom retrieval tool with a hidden permission bypass. Originals
survive normal restarts; they are snapshots, not evidence of current file state.

Artifacts share the **local history trust boundary**: another session authorized
to read the artifact path can read it. Source permission revocation does not
revoke an existing snapshot. This is not per-session isolation or per-source
reauthorization. Keep the state directory out of Git, sharing and broad indexes,
just as you would conversation history. Do not widen permissions to read it.

The store stops adding records at 256 directories or 128 MiB, and reserves
256 MiB of free disk space. Existing originals are never evicted automatically;
at capacity, new output passes through normally. A nonblocking writer lock also
falls back to native output while busy. After an unclean process exit, a stale
`.writer.lock` may disable compression: with the service stopped, verify the
recorded PID is dead before removing that lock. Do not delete originals needed
by retained chats. Manual archival/removal is an operator decision.

## History stability and measurement

Compression happens once when a root tool call completes. It does not rewrite
old messages or change the provider prompt on every request; no periodic context
rewrite or model-based conversation compaction was added. This avoids introducing
additional history churn, but does not guarantee a provider cache-hit rate.
Interrupted nested calls can conservatively skip compression; root tracking is
bounded and never changes tool execution, retries, or subscription admission.

`harness-metrics` includes `context_compression` per root workload: prepared
results, strategies and before/after character counts. It reads metadata only.
These are prepared projections before later native truncation/publication, not
verified token or subscription-credit savings. Evaluate accepted outcomes,
repeated reads, corrections and actual provider usage alongside these counts.

Headroom inspired conservative recoverable compression, not a dependency or
copied implementation. Pinned source references and attribution are in NOTICE.
Further source-scoped retrieval authorization requires a native permission API;
arbitrary MCP compression, semantic pruning and automated history rewriting
remain outside this implementation.

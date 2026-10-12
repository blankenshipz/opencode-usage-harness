# Conservative diff previews

Large recognized `git diff` tool results can now omit surplus **unchanged context**
when the net savings justify a preview. Every file header, hunk header, addition,
deletion, EOF marker and metadata line is retained. Three context lines near
changes and hunk boundaries remain; omission markers state how many unchanged
lines were removed. No relevance scoring drops files or changes.

The result is explicitly labeled **NOT an applyable patch**. Original hunk
coordinates stay visible for navigation, but omission markers make this a review
preview, not input to `git apply`. Read relevant original context when evaluating
behavior or preparing edits. Full exact originals are stored and retrieved through
native read under the existing snapshot/permission contract.

Only uncomplicated `git diff` shell commands receive this transformation. Source
reads, edits, compound shell scripts and unknown tool results are not reclassified
as diffs. Binary, combined, malformed, CRLF or unprofitable diffs pass through.
Default short-context diffs often save nothing and therefore remain unchanged.
As with other projections, storage failure/capacity and output-budget constraints
leave the original tool result intact. No extra model inference is involved.

The strategy is `diff-context-preview`, deliberately marked non-lossless because
unchanged context is omitted from the projection. It preserves all changes but
is not guaranteed to supply enough surrounding code for every review judgment.
Metrics count actual prepared preview size including the retrieval marker.

Headroom's [diff compressor](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/crates/headroom-core/src/transforms/diff_compressor.rs)
inspired this independent implementation. We did not adopt its file/hunk caps or
relevance-based omission of changes.

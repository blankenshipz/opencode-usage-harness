# Complete bounded JSON reading

Native line reads can truncate a single long JSON line even when the file has
only one line. `large_file_json` provides exact character pages for harness
agents, including reviewers that have no shell tool. It uses no inference and
works identically across model families and subscription pools. Native agents
retain their existing tool set.

Start with:

```json
{"path":"fixtures/cases.json","limit":6000}
```

The result identifies the source SHA-256, source byte count, current character
offset, exact text, and whether reading is complete. When incomplete, continue
using the returned `next` offset and source hash:

```json
{"path":"fixtures/cases.json","offset":6000,"limit":6000,"expectedSha256":"<sourceSha256 from the first page>"}
```

Use the actual returned offset, which may adjust for a Unicode surrogate pair.
Concatenating consecutive pages from one unchanged hash reconstructs the exact
UTF-8 source text. Pages are fragments, not necessarily standalone JSON values.
Review remains incomplete until all relevant evidence has been inspected; the
tool's `complete` field means that page reached the end, not that earlier pages
were read or that a review passed.

The reader validates JSON syntax but never reserializes the parsed value. Large
integer literals, duplicate object keys, escapes, whitespace, and key order stay
intact. Invalid JSON and invalid UTF-8 produce sanitized failures without echoing
source text. The maximum source is 1 MiB; the default page is 6,000 characters and
the maximum is 12,000. Larger sources require a deliberately scoped evidence
artifact or a separate supported review method, not an unrestricted read.

Every invocation first uses native read authorization for the requested path and,
when different, its canonical path. The bounded local file read rejects changed
files and symlink retargets. No native permission denial is retried or bypassed;
no shell permission, direct-read exception, snapshot, write, network request, or
provider fallback is created. Existing 350-line limits and summary behavior stay
unchanged. This helper requires the local V2 runtime's native read tool; it is not
a remote-filesystem transport.

There is no automatic review retry or worker resumption. Installation requires
the normal managed plugin release; changing source files alone does not refresh
an already running OpenCode service.

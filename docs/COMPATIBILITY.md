# Runtime compatibility

The toolkit does not bundle OpenCode, OpenChamber, or their binaries. The reference runtime is upstream OpenCode 2.0.18 plus `compat/opencode-2.0.18-required-plugins.patch`. Its exact source archive and patch hashes are in `compat/runtime.json`.

The patch enforces required-plugin presence on guarded model-request paths and rejects sessionless generation where the guards cannot run. A plain version string or an environment variable alone does not prove this enforcement. Stock OpenCode must not be advertised as providing the same fail-closed behavior.

## Building a compatible runtime (advanced)

Use a separate build directory, outside your existing OpenCode checkout/data. Download the `source_url` from `compat/runtime.json`, verify its SHA-256 against `source_sha256`, and stop on any mismatch. Review the patch and verify `patch_sha256`. Keep the verified archive as a reproducibility input.

Extract the verified upstream archive into a fresh directory. From the extracted source root:

```sh
git apply --check /absolute/path/to/harness/compat/opencode-2.0.18-required-plugins.patch
git apply /absolute/path/to/harness/compat/opencode-2.0.18-required-plugins.patch
bun --version  # The pinned upstream toolchain is 1.4.2.
bun install --frozen-lockfile
```

Run upstream's prescribed core/server tests for the changed hooks, generation paths, and location activity before building. The upstream package test scripts isolate their test environment; use them rather than pointing tests at a real account. Build from `packages/cli` with a new output directory:

```sh
OPENCODE_CHANNEL=local OPENCODE_VERSION=2.0.18-subscription \
  bun run script/build.ts --single --skip-install --skip-web-ui \
  --outdir=/absolute/path/to/new-build-output
```

The build script deletes the chosen output directory, so it must be a dedicated new build directory. Dependencies/toolchains are upstream components and may require network downloads. This build procedure is not run by the toolkit installer. Record the resulting executable's SHA-256 and retain it when deploying.

## Validation boundary

The patch was checked against pristine files from the checksum-pinned source archive during extraction. The original installation ran the patched runtime on macOS x64. The portable source release is tested with offline fixtures, not a new model-backed end-to-end run on every platform. Linux and Apple Silicon runtime builds need their own integration validation. Automatic binary releases and a fully automated runtime builder are future work.

Before enabling inference in a new installation, verify that absent/failed required plugins block a model request, that only the intended OpenAI provider is available, and that auth is ChatGPT OAuth with no API-key/base-URL override. Use local fake-provider negative tests first; never use a paid request to test a financial guard.

OpenChamber is an optional UI. Install and configure it separately against the same backend and state. The toolkit does not modify launchd/systemd, relay pairing, passwords, or listening addresses.

# Changelog

## 0.1.0 — experimental source release

- Portable extraction of subscription checks, quota telemetry/pacing, model status, bounded reads, task intent/ownership, and outcome recording.
- Read-only root-workload metrics with explicit uncertainty about blocked time and completion evidence.
- Isolated profile generation with discovered model mappings and approval-based public defaults.
- Offline versioned install/update, checksum inventory, and code rollback.
- Pinned OpenCode 2.0.18 required-plugin compatibility patch and upstream license.
- Fixture-based tests and macOS/Linux CI configuration; no bundled credentials, databases, provider inference, or runtime binaries.

Known gaps: a fresh public-runtime integration run, prebuilt compatible binaries, automated runtime builds, signed releases, and OpenChamber installation/pairing automation are not included.

# Changelog

## 0.2.0 — unreleased

- Preflight build/test disk capacity, expose check preparation and read-only receipt/session health tools, and preserve unknown ownership instead of assuming liveness.
- Distinguish unmeasured outcome counters from zero and fresh/reused/unrun evidence; guide selective phase handoffs and cheap pre-freeze checks.

- Add opt-in private check receipts and release-freeze guidance to preserve failure diagnostics and reduce validation churn.
- Prioritize a concrete end-to-end acceptance journey when assigning supporting infrastructure.

- Persist scoped dispatch-denial receipts and suppress unchanged retries; declared recovery remains subject to native permission and provider checks.

- Distinguish working/dependency waits/user action in checkpoint reporting and batch journal maintenance around meaningful changes.

- Coalesce meaningful worker checkpoints into occasional UI-only OpenChamber notices; no extra inference or model-context injection. Includes an opt-in 2.0.3 UI patch; native mobile clients need a matching rebuild.

- Persist sanitized worker progress with an opt-in OpenChamber 2.0.3 reconnect adapter.
- Compact acknowledged same-child continuations; preserve full intent for new/revised/refreshed assignments.
- Guard repeated deterministic patch failures and clarify path/context recovery.
- Require explicit journey/evidence/owner planning before broad parallel implementation.

- Concise progress-update guidance and observed reasoning/responding phases on foreground worker cards.

- Foreground worker activity on parent OpenChamber tool cards without extra model calls.
- Idempotent completion telemetry ledger and deduplicated historical usage reporting.

- Provider-neutral offline subscription-pool planning with shared allowance groups, per-window pacing, capability tiers, freshness checks, and parallel slot accounting.
- Documented adapter boundaries and remaining runtime reservation/dispatch work; live profile remains Codex-only.
- Credit Spotify’s blog and Shunt project for large-file context-control inspiration.

## 0.1.0 — experimental source release

- Portable extraction of subscription checks, quota telemetry/pacing, model status, bounded reads, task intent/ownership, and outcome recording.
- Read-only root-workload metrics with explicit uncertainty about blocked time and completion evidence.
- Isolated profile generation with discovered model mappings and approval-based public defaults.
- Offline versioned install/update, checksum inventory, and code rollback.
- Pinned OpenCode 2.0.18 required-plugin compatibility patch and upstream license.
- Fixture-based tests and macOS/Linux CI configuration; no bundled credentials, databases, provider inference, or runtime binaries.

Known gaps: a fresh public-runtime integration run, prebuilt compatible binaries, automated runtime builds, signed releases, and OpenChamber installation/pairing automation are not included.

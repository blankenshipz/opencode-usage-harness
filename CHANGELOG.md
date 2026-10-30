# Changelog

## Unreleased — bounded Claude telemetry recovery

- Share private Claude usage snapshots and in-flight lookups across processes.
- Back off after transient telemetry failures; permit bounded reuse of verified
  disabled-overage evidence without treating a failed lookup as quota exhaustion.
- Keep Claude quota telemetry fresh for 60 seconds while allowing disabled-overage
  recovery for less than 24 hours from its original successful verification;
  failed checks never extend that horizon and stale quota remains non-routing data.
- Keep authentication, financial expiry, unsafe settings and applicable exhausted
  windows blocking; preserve original evidence timestamps and expose cache state.
- Keep Codex admission independent; no automatic inference retry or paid fallback.

## Unreleased — router-directed independent review

- Let the router choose whether a bounded review is useful; avoid routine extra
  review and quota-driven busywork. Preserve the configured primary router.
- Bind managed review provenance to an admitted implementation worker and distinguish
  preferred diversity from explicitly required cross-family review.
- Document native/direct entry points and single-pool behavior honestly.

## Unreleased — routing and deployment hardening

- Add explicit executable verification with shell capability checks, retained model
  overrides and conservative write ownership; keep static reviewers read-only.
- Require routing assessments for new managed work when policy is enabled, while
  retaining existing children and native Build/Plan contracts.
- Reject policy typos and invalid reserve/scoped options; distinguish unknown weekly
  pace and match provider scopes through explicit model/family semantics.
- Preserve safe Anthropic usage-check diagnostics and coalesce concurrent reads
  without inference retries, account switching or stale admission.
- Stage private releases reproducibly with reviewed adapters and artifact hashes;
  upstream OS-backed registry locking and check configuration/dependency drift.
- Document independent Claude and Codex pools, provisional task-fit preferences,
  cross-family review, harness-prefixed roles and capability preflight. These are
  development-branch features, not a claim that the v0.1.0 tag contains them.

## Unreleased — recovery correctness

- Bind compaction outcomes to their native ID, preserve failure history, and
  expose continuation ownership and observed native activity separately.
- Persist sanitized quota-recovery notifications without retrying inference or
  relaxing admission; retain pending delivery across failures.
- Stage a version-specific native child-result boundary repair separately from
  plugins; runtime installation remains an explicit deployment step.
- Exercise real installed entry points and generated config/launchers offline,
  detect provenance drift and missing dependencies, and include integrations in
  the installer payload.

## 0.2.0 — unreleased

- Apply effective configured models on same-child continuations, preserve explicit overrides, and expose routing decisions. Quota pacing downshifts explicitly routine/normal-risk work within the same provider.
- Retain cumulative per-lane and task work accounting; require evidence-backed reassessment at idle admission without adding human permission gates.
- Add opt-in native same-session checkpoint compaction and high-context advisories, with full-intent refresh afterward.
- Reduce shared instruction sections by about 60%; prefer direct bounded delegation and batch bookkeeping.
- Add a dry-run-first historical-session linking utility with private metadata backups and canonical-session execution guidance. Marked copies cannot dispatch or start model inference through the harness.


- Default sustained dispatches to native background completion, inject cooperative 10-minute/30-step checkpoint reminders at existing model boundaries, and support focused continuation targets.
- Detect repeated continuations despite artifact churn with bounded, self-reported semantic evidence; persist optional human/device verification attempts with readiness, expiry and retained result references.

- Add compression skip/overhead/retrieval diagnostics, passive prepared-context drift monitoring, and recoverable Git diff previews that preserve every changed line and hunk.

- Specify and regression-test model-family-independent context compression; keep provider admission and token accounting separate.

- Automatically compress eligible new V2 tool results with lossless JSON tables, search prefixes and exact-repeat test logs; retain private originals for bounded native reads, preserve CodeMode values/history/permissions, and expose metadata-only preparation metrics.

- Add opt-in bounded check-log previews with exact-repeat compaction and retained originals; credit Headroom design inspiration without adding its dependency or proxy.

- Consolidate convergence guidance: distinguish verified outcomes from activity, revisit an expanding task at existing progress boundaries, and carry review findings forward to affected-code follow-ups.
- Add passive metadata-only execution timing and overlap-aware workload reports; unknown time is not attributed to provider throttling.

- Ground acceptance in normal user journeys, change verification after repeated visible misses, and report remaining acceptance before test counts.

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


### October 23 activation validation

- Pin the actual 2.0.30 runtime source separately from the older managed layout.
- Capture child-result boundaries before prompt admission, covering children that
  finish before their observer starts; preserve exact-generation restart delivery.
- Validate the real Intel build, workspace checks, 38 native integration tests and
  compiled plugin startup. Document the approved private activation and rollback.

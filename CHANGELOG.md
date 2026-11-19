# Changelog

## Unreleased — mid-run compaction of a running child

- A running managed child whose observed context reaches the absolute trigger (`min(HARNESS_COMPACTION_TOKENS or compaction_tokens, 80% of a known window)`) is compacted without waiting for it to finish and be collected. The harness admits one native steered compaction from the child's model-request `context` hook; OpenCode 2.0.30 runs it at the next step boundary, after the current step and its tool calls settle and before the next model request.
- Gates: current running generation with current intent, no denial or cancellation; no explicit parent compaction in progress; native state active with no running tools and no active descendants; one pending at a time; growth since the previous one (new observation and at least a quarter of the trigger over the first post-compaction observation); a failed compaction stops further attempts for that generation; at most 8 per generation and 2 admission failures. `HARNESS_MID_RUN_COMPACTION=off` disables new admissions.
- The native summary request receives the handoff brief, `task_intent` continuation reference, recorded check results, latest checkpoint and previous completion receipt as system data. After the compaction completes, later requests of that generation carry the same frozen continuation.
- Compaction IDs derive from the generation's completion marker. `dispatch_runtime.py` completion and terminal receipts accept exactly those compaction rows inside the generation's chain; any other compaction still invalidates a receipt. Status shows `midRunCompaction` metadata, never the brief. `subscription-guard.mjs` is unchanged (hash-pinned): a quota failure in a mid-run summary request is not given its own compaction receipt; it marks mid-run compaction failed for the generation, and the child's next request reports the quota block as a dispatch receipt.

## Unreleased — absolute-token compaction trigger

- High context pressure and compaction eligibility now start at `min(absolute, 80% of the known usable window)` observed input tokens, or at the absolute threshold when the window is unknown. Previously a known window disabled the absolute rule, so an 872k window deferred pressure to ~698k tokens while a builder grew to 284k.
- The absolute threshold defaults to 120000 and is configurable: `HARNESS_COMPACTION_TOKENS` (environment, wins), else `configure.py --compaction-tokens N` (persisted as `compaction_tokens` in `config/configure-choices.json`), else the default. Invalid values fall through to the next source and never disable the trigger.
- Context observations report the effective `threshold`, `thresholdBasis` (`absolute_tokens` or `window_ratio`) and `absoluteThreshold`; high-context advisories add `trigger` and `triggerBasis`.

## Unreleased — settle cancelled, interrupted and orphaned dispatches

- At plugin start, stale `starting`/`running` dispatch-ownership rows and in-flight admissions are reconciled against native state. A row whose child's exact native outcome is `failed`/`interrupted`, whose child session is missing, or whose admitting server process has exited (with the child idle) is settled to `interrupted`/`failed`. The settlement is recorded in `reconciliation`, the dead admission marker is cleared, and the row's global writer leases are released, so a new overlapping lane is no longer rejected. Rows are never touched while the owning process is alive, while the child or a descendant is active, or while an unreported native child of the same parent and role is active. A successful child is never marked failed.
- At runtime, a background generation whose native outcome is `failed` or `interrupted` is settled the same way when the result-delivery watcher observes it, instead of staying `running` until an explicit collect or reconcile.
- `task_dispatch_cancel` on a coordinator also cancels admissions its subtree started that have no child identity yet, and it releases their leases.

## Unreleased — reliable handoff result delivery

- Every admitted handoff generation records a durable `resultDelivery` binding (parent message and tool-call IDs, completion marker). After the handoff call returns, throws or is interrupted, a watcher waits for the child's exact native terminal outcome. It then checks read-only evidence through the new `dispatch_runtime.py --delivery-evidence` reader: whether the parent's foreground tool part completed, or whether a native subagent notice for the child is in the parent's transcript or inbox.
- If neither arrived, it sends one synthetic `<subagent …>` message to the parent with the child's final report and real outcome (`succeeded`, `failed` or `interrupted`) after a 15 s grace period. This covers an aborted, timed-out or interrupted foreground wait, a returned result that core never recorded (the part stays `running` and is later shown as `Tool execution interrupted`), and a missing background completion notice. The message ID is derived from the child and generation and the binding records the delivery, so a result is never delivered twice. Pending deliveries are re-armed when the plugin starts.
- A foreground child that succeeded after its parent's wait was aborted is recorded as `completed` with its report retained (`outcomeCorrection` keeps the previous state), so `task_dispatch_collect` returns it. A parent the user interrupted gets the notice queued without being restarted. Cancelled children get no notice. `task_dispatch_status` shows each owner's `resultDelivery` status.

## Unreleased — parent cancellation of dispatched children

- Add `task_dispatch_cancel {taskId, workKey and/or sessionID, reason}` for delegating roles (router, coordinator). Only the recorded dispatcher of a child can cancel it. Grandchildren are refused unless the caller dispatched them. Other task trees never match.
- Cancellation rejects the child subtree's pending permission asks (plain `reject`), interrupts the child and its active descendants with `session.interrupt({resume:false})`, then records `state:'cancelled'` and `cancellation {reason, cancelledAt, cancelledBy, generation, previousState, interrupted, pendingPermissionsRejected}`. It also clears the record's write scope and removes the child's global writer leases. Records the cancelled child dispatched are cancelled with it. The result lists the released locks.
- Repeated calls return `already_cancelled`, and idle children return `already_finished` with no changes. If the native interrupt fails, nothing is released.
- A cancelled child and its descendants cannot start another model request until the parent re-admits them through `task_dispatch`. A foreground handoff that is cancelled while running keeps the cancellation.
- `task_dispatch_status` reports `cancellation` per owner and a `cancelledChildren` list, including in `summary:true`. `configure.py` allows `task_dispatch_cancel` only for delegating roles (built-in agents keep `task_*` denied) and adds one line to their guidance.

## Unreleased — /tmp scratch space

- Add `configure.py --allow-tmp-scratch` / `--no-allow-tmp-scratch` (persisted as `tmp_scratch`, default off). When on, the profile adds one global rule, `external_directory /tmp/*` allow, so agents can use /tmp scratch files without a prompt. Read/edit secret denials, shell rules and agent-level rules are unchanged.

## Unreleased — monitoring fixes (quota CLI, lock files, Claude adapter entry)

- `configure.py` adds the vendored opencode-claude-auth 3.0.0 adapter to the generated `plugins` list when Anthropic is enabled. New `--claude-auth-plugin DIR` (persisted). Without it, configure detects `<release>/plugins/v2/claude-auth`, `<prefix>/vendor/claude-auth`, or a still-valid entry in the profile being replaced. It warns when none is found. `install.py` does not build or vendor the adapter; see docs/CLAUDE-SUBSCRIPTION.md.
- `bin/subscription-quota.mjs` reports the plugin's newest cached Claude snapshot with verification time, age and a `STALE` marker (older than 2 minutes) instead of `unknown [adapter_unavailable]` when one exists. Cache files hold no credentials and only owner-private regular files are read.
- Progress snapshots remove their per-call `.flock` file on release, using an inode re-check so mutual exclusion holds. Plugin start prunes old, empty, unlocked lock files left by earlier releases. Dispatch-ownership locks are unchanged.
- Documentation covers all fixes on this branch: handoff result delivery and background dispatch metadata, up-front `task_intent`, pending-permission re-evaluation on reload, the raw-command redirect guard, `--shell-policy permissive`, router `repo_identity`, the agent-registry 404 window on reload (docs/COMPATIBILITY.md), and the three items above.

## Unreleased — shell permissions and reload

- Add `configure.py --shell-policy allowlist|permissive`. The choice is persisted in `config/configure-choices.json`, and the default stays `allowlist`. `permissive` generates `shell *` allow plus a dangerous-command ask list. Builder roles are told to write files with edit/write instead of shell redirection.
- Add a raw-command shell guard. It forces a native ask for unquoted redirects to secret-looking paths, for bare redirects, and for compound-command redirect segments that match a shell ask rule the OpenCode 2.0.30 parser drops.
- Re-check pending permission asks after a config reload and reply `once` only for requests the current rules allow. Probes never create new asks.
- Add a read-only `repo_identity` tool for roles without shell.
- Write the generated profile atomically (temp file, then rename).

## Unreleased — handoff results reach the parent

- Fix lost handoff results: harness dispatch metadata (for example `routing.modelOverride: undefined`) failed OpenCode's strict JSON tool-event validation after the call was marked settled, so foreground reports never reached the parent and background calls stayed "running" until marked interrupted. Dispatch results now carry plain JSON metadata, and harness-only subagent results always include the declared `{sessionID,status,output}`.
- Foreground handoffs return the child's bounded final report (16,000 characters) with status, session, agent and generation, and retain it so `task_dispatch_collect` can re-read it. A lost foreground result is recovered only from the exact native terminal receipt. Background handoffs return the child session, agent, generation and exact collect arguments immediately.
- State the intent-first requirement in tool descriptions, schema field help and delegating-role instructions. Reject a handoff without shared intent before agent, quota or ownership work, and name the exact `task_intent` call and the `intentRevision`/`checkIds` to pass. The handoff prompt is now the last schema field.

## Unreleased — model-aware compaction advice

- Derive advisory context pressure from the actual model/variant input budget, reserving maximum output space, instead of treating every model as high pressure at 120,000 tokens.
- Bind usage to the exact completed assistant's model and retain conservative fallback advice when model selection, catalog or limits cannot be verified. Expose budget, ratio and evidence in status and use the same calculation for worker handoffs.
- Preserve native automatic compaction, checkpoint ownership, permission and financial safeguards. No inference experiments or assumed quota savings.

## Unreleased — compaction handoff wait

- Keep the requesting parent's dispatch call open through a bounded native idle wait after same-child compaction. Return the exact generation/compaction outcome so normal continuation can proceed without a separate idle handoff.
- Preserve pending/recovery state on timeout, unavailable observation, mismatched IDs or failure. No polling, automatic child execution, status-triggered inference or changes to admission safeguards.

## Unreleased — hands-on integration lead guidance

- Clarify that an existing capable builder can lead an admitted end-to-end slice through its existing paths and gates, while the root retains intent, completion and separate review dispatch.
- Require acceptance, input/output and check-prerequisite preflight before evaluation; keep router supervision light and evidence-led, without automatic idle wakes, retries or closure from test counts.
- Document authorized incremental publication and an operator-configurable Opus medium lead/Sol high milestone-reviewer trial for dual pools; it is not a default or a superiority claim, and one-pool users retain the same pattern with available models.

## Unreleased — idle Claude windows and installed telemetry

- Treat only fresh, zero-use, unlocked Claude account session windows without a reset as unstarted; preserve unknown pacing and all scoped, exhaustion and financial guards.
- Verify telemetry against the configured runtime state root in the installed collector.
- Advise rereading current affected lines before rebuilding a context-mismatched patch, within the existing instruction budget.

## Unreleased — stopped generations and root updates

- Add explicit parent-only terminal reconciliation across intent revisions, preserving exact native generation evidence without treating failure, cancellation or superseded success as current-task completion.
- Release only the matching inactive write reservation; retain denials and bounded settlement history.
- Extend cooperative progress reminders to managed root routers using native execution and visible-text timestamps, without extra requests or forced handoffs.

## Unreleased — complete bounded JSON review

- Add shell-free, hash-bound character paging for JSON that native line reads truncate.
- Preserve exact source text and existing read permissions; reject changed files and oversized sources rather than silently omitting evidence.

## Unreleased — compact integration assignments

- Add an on-demand integration template using existing intent and dispatch fields: agreed producer/consumer contract, supporting paths, one integration check and exact next-owner evidence.
- Encourage meaningful integration before intermediate freezes without changing admission, review or execution rules.

## Unreleased — native recovery and preflight guidance

- Collect narrowly recovered native provider results only with retained matching retry proof, exact recovery boundary and a later successful same-generation terminal result; preserve all earlier errors.
- Expose lane/root cumulative-review requirements before continuation while preserving admission thresholds and explicit reassessment.
- Make outcome-validation errors corrective and field-specific without echoing private evidence or weakening acceptance.

## Unreleased — receipt guidance and handoff timing

- Explain both receipt/freshness mismatch directions with indexed corrective diagnostics and tool field guidance; acceptance rules are unchanged.
- Record bounded, generation-bound completion, collection and continuation timings without automatic execution or new approval gates; unavailable history stays unknown.

## Unreleased — measured context and bounded search

- Preserve completed context usage across streaming messages and invalidate pre-compaction observations; unknown is no longer zero.
- Surface owner-bound safe-checkpoint compaction advice without status-side execution or new permission gates.
- Bound large recognized search previews, report omissions and preserve exact originals for native retrieval.


## Unreleased — scoped Git publication

- Separate frozen-commit publication from checkout-exclusive deployment.
- Require explicit publication scopes and commit identity; retain overlapping leases, hooks and native approvals.


## Unreleased — scoped verifier capabilities

- Recognize scoped edit capability, including verifier artifacts, without changing native path permissions.
- Report missing capabilities accurately for existing assignments instead of a misleading worker-identity error.


## Unreleased — truthful handoff and publication guidance

- Remove an accidental blanket “never push” instruction: authorized publication proceeds after required gates.
- Align background-result collection eligibility with the actual generation/owner/intent/model checks, with actionable structural blockers.
- Distinguish queued steering from native execution and document compact cross-conversation evidence contracts without cross-parent takeover.


## Unreleased — scoped continuations and delivery

- Retain admitted writer scopes across non-deploy continuation operation changes; require explicit scope when adding write authority instead of silently reserving the workspace.
- Explain ownership conflicts with requested and conflicting paths.
- Hide direct mutation/shell tools from harness router and coordinator contexts; native permissions remain authoritative.
- Keep publication/delivery assignments current and separate from feature acceptance, and agree on an executable producer/evaluator contract early.

## Unreleased — productive checkpoints

- Turn elapsed-time/step checkpoint reminders into progress reassessments, without forcing a handoff during useful authorized work.
- Add optional compact dispatch status with exact generation, compaction, collection and human-attempt recovery metadata.
- Permit verifier fixture/script edits under assigned `.artifacts` paths while retaining production edit and secret-file denials.
- Prefer an integrated executable journey, meaningful implementation/verification chunks, and selective context refresh over repeated bookkeeping.
- Clarify shared Git coordination through explicit existing ownership scopes; no new lock service or automatic permission bypass.

## Unreleased — native wait visibility

- Distinguish pending native questions and permissions from execution, including sessions still marked running. Keep inaccessible or malformed wait evidence unknown and preserve caller ancestry checks.
- Add explicit generation-bound collection of background completion evidence and revalidate author provenance before review; no inference, status-triggered mutation or retroactive certification of legacy work.

## Unreleased — workflow recovery and honest optimization

- Make invalid checkpoint fields actionable; clarify human-action status and Git-hook discipline.
- Expose same-child intent-rebind recovery without automatic execution or relaxed gates.
- Preserve GitHub CLI config references across isolated launcher environments.
- Use medium effort for new ordinary Claude builder assignments in the example policy.
- Separate protected compression skips from unsupported formats and explicitly report absent observed savings.

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

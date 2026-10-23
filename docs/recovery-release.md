# Recovery release: staged changes and activation

This repair has separate source, build, and deployment stages. Publishing these
patches does not restart OpenCode, resume a child, or change approvals or financial
policy. The October 23 private Intel deployment was activated only after approval
and a repeated idle/interaction check; local deployment receipts remain private.

## Findings

The October 23 review covered all persisted V2 turn records since the October 17
harness change. Historical V1 `message`/`part` tables do not contain that activity;
the relevant tables are `session_message` and `session_v2`.

1. A historical `compactionFailed` boolean outlived its compaction. Two reported
   native compactions were confirmed completed. Status must reconcile only the
   matching compaction ID, retain failure history, and distinguish completion of
   compaction from completion of the user task.
2. A failed compaction contained quota-telemetry timeout evidence. Admission must
   remain blocked, with a retained child and recovery notification, rather than
   treating missing telemetry as exhausted allowance or retrying inference.
3. Native child-result selection searched recent successful assistant messages
   without an execution boundary. This can return an older answer after a
   compaction-only execution. Native source changes require a separately built
   runtime; replacing a JavaScript plugin cannot fix the compiled binary.
4. The actual source installer rejected the existing `integrations` directory.
   Tests now install the actual checkout, generate its profile, import its
   staged entry points, and exercise its guard with a fake quota executable.
5. Seventy sampled dispatch records still said running when their native child
   was idle. Recorded dispatch state is not proof of active execution or task
   completion. Status needs to expose native activity separately.

The turn audit found ordinary tool failures and cancellations as well as three
permission rejections. These counts do not establish task quality or justify
weakening approvals. No additional automatic retry or permission bypass is added.

## Environment contract

The portable quota subprocess accepts only `HOME`, `PATH`, `LANG`,
`HARNESS_STATE_DIR`, `CODEX_HOME`, `HARNESS_CODEX_BIN`, and `HARNESS_PYTHON`.
These select local configuration and executables; they do not admit provider API
keys. The reviewed older private guard used only fixed home, path and locale.
Their tests must express their respective deployment contracts, rather than
silently forwarding the process environment to make one test pass. macOS can
inject its own `__CF_USER_TEXT_ENCODING` metadata into a child process.

The existing recursive plugin inventory already includes `index.mjs`. The new
`src/release_preflight.py` supplements that inventory with explicit generated
config, launcher, dependency and entry-point provenance. Snapshot only reviewed
staged bytes. A receipt proves byte identity and importability, not the safety of
the chosen policy or compatibility with an arbitrary OpenCode version.

## Native source compatibility and focused fixtures

`compat/opencode-2.0.30-managed-recovery.patch` applies to the exact five files
listed in `compat/opencode-2.0.30-managed-baseline.json`. That file records both
original and patched SHA-256 values. The deployment label is descriptive: package
versions in the supplied source do not all match the installed binary's version.
Hashes, not the label, control applicability. The managed source also differs
from the matching upstream archive, so a pristine-source patch is insufficient.

The recent-assistant selection was compared with the matching upstream archive;
the managed continuation/observer changes are custom. This report does not claim
every upstream version has the same defect or that these changes are upstream fixes.

The managed patch adds an optional `notificationID` to the internal Job wait
contract. A mismatch returns immediately, allowing the observer to retrieve its
exact durable notification instead of waiting for a replacement generation.
Existing callers without the optional field keep their behavior. There is no
database schema change. Deploy the Job, observer, restart and tool-caller changes
together; partial replacement would reopen the generation race.

Run the focused fixtures with Bun 1.4.2 and a separately prepared, pinned
Effect 4.0.0-rc.112 installation:

```sh
python3 scripts/test_native_recovery.py --source /reviewed/managed-source \
  --bun /toolchain/bin/bun \
  --effect-module /isolated/deps/node_modules/effect/dist/index.js
```

This command checks original hashes, copies only required source into a temporary
directory, applies the patch, verifies output hashes, and runs nine fixture tests
against the actual patched TypeScript. It never writes the supplied source or
downloads dependencies. Storage/session/app services are mocked; the actual Job
wait and subagent result/notification implementations execute. The tests cover
stale-result rejection, rapid same-child continuation, both generations' delivery,
pending notification retry, and observer restart. They do **not** constitute a
full native build, core typecheck, or managed-server restart integration test.
Those checks remain mandatory before native activation. The reviewed installed
source's dependency links point to missing targets; rebuild dependencies in an
isolated source checkout rather than repairing live paths during active work.

Example, using isolated staged paths:

```sh
python3 install.py --prefix /staging/install stage --source /reviewed/checkout
candidate=/staging/install/releases/REVIEWED_VERSION
python3 "$candidate/configure.py" --state-dir /staging/profile \
  --models /staging/discovered-models.json
python3 src/release_preflight.py snapshot --receipt /staging/provenance.json \
  --plugins "$candidate/plugins" --node /toolchain/bin/node \
  --artifact /staging/profile/config/opencode.json \
  --artifact /staging/install/staged-bin/codex-quota \
  --artifact /staging/install/staged-bin/harness-check \
  --artifact /staging/install/staged-bin/harness-metrics \
  --artifact /staging/install/staged-bin/harness-session-link \
  --artifact /staging/install/staged-bin/harness-manage \
  --entry "$candidate/plugins/v2/subscription-guard/index.mjs" \
  --entry "$candidate/plugins/v2/task-outcomes/index.mjs" \
  --entry "$candidate/plugins/v2/large-file-context/index.mjs" \
  --entry "$candidate/plugins/v2/model-status/index.mjs"
python3 src/release_preflight.py verify --receipt /staging/provenance.json
# After approval, toolkit activation is gated by the same receipt:
python3 install.py --prefix /staging/install activate \
  --version REVIEWED_VERSION --provenance /staging/provenance.json
```

Include **every** intended launcher, generated config, validator, quota executable,
runtime binary and entry point using repeated flags. Keep the local receipt
private: it contains local paths and hashes, never configuration contents.
Verification detects changed/missing bytes, extra plugins, missing Node and
unresolvable entry imports. It does not discover omitted external dependencies;
enumerating the deployment remains the release owner's responsibility.
An installed toolkit's payload manifest is included automatically, covering
validators and helpers outside the plugin tree. The `stage` command generates
launchers under `staged-bin`; include all of them in the receipt. `activate`
verifies the staged provenance before changing `current`. Existing `install` and
`update` remain standalone-toolkit operations for compatibility; neither installs
or activates an OpenCode runtime. The native service activation below is separate.

## Activation and rollback procedure

1. Keep the live release untouched. Stage the candidate plugins and a separately
   patched and rebuilt native runtime. Apply the native patch only to its stated
   matching baseline; never overwrite unrelated custom runtime changes.
2. Run the offline regression suites against the staged files and run the
   upstream-compatible native fixture tests against the patched source. No real
   provider calls or quota consumption are needed. Preserve build/test logs.
3. Generate an isolated profile and review its effective permissions, provider
   policy, financial guard, database/state paths and launcher environment.
   Preserve existing project config precedence and Workrelay location bindings.
4. Record and verify provenance for the complete candidate. Reject missing
   dependencies, mismatched upstream versions or config drift before activation.
5. Inspect native session activity, pending tools, approvals, forms, compactions
   and admitted jobs. Idle alone does not prove the user's work is finished.
   Wait for a safe boundary without interrupting Tessera. Obtain the user's
   approval for this exact candidate and activation window.
6. Back up affected installed plugins, binary, config, launchers, release
   manifest and ownership registry. Use SQLite's online backup facility if a DB
   snapshot is needed; never copy only a live WAL database file. Secure backups
   as private data. Record each current hash and the rollback destination.
7. Activate only during that approved window. Install the reviewed artifacts,
   update expected hashes, and use the supported managed service restart. Check
   authenticated local health, loaded config/artifact paths and installed hashes.
   Inspect recovery status without dispatching inference. Mark verified-live only
   after those checks pass.
8. On a health/provenance regression, restore the saved artifacts and manifest,
   restart through the same managed launcher, and check health/hashes again.
   Preserve the current database and registry; do not roll back user work or
   erase delivery receipts just to restore code. Older plugins may ignore added
   receipt fields, so retain the backup and reconcile pending notifications before
   any later recovery.

No live activation, service interruption or automatic continuation is part of
publishing these source changes.


## Validated 2.0.30 runtime baseline and activation

The installed binary's actual build tree was the October 15 upgrade source,
with Effect 4.0.1 and the newer service/node wrappers. The older `v2-current/source`
tree contains a different layout despite its deployment label. Use
`compat/opencode-2.0.30-runtime-recovery.patch` and its `runtime-baseline.json`
for the actual 2.0.30 build; the `managed` pair remains for the separately hashed
older layout. These patches are alternatives, never cumulative. Verify every
original hash before applying either, then every output hash afterward.

Real integration tests exposed a further race: a child can finish between prompt
admission and the observer starting. The caller now persists the last message
boundary **before** admission, plus the admitted prompt ID and an explicit
boundary-captured flag. The observer and restart path use this retained boundary.
An empty captured history is distinct from legacy missing metadata. Legacy jobs
use a conservative boundary and may produce an explicit no-new-result response
rather than replaying an older answer. Recovery metadata fields are optional;
there is no database migration or approval/provider-policy change.

Validation against the actual staged 2.0.30 runtime:

- Full workspace check: 35 tasks passed; final core typecheck passed.
- Five real core test files: 38 passed, zero failures, 297 assertions. Coverage
  includes jobs, subagent execution/lifetime, activation and native compaction.
- Intel macOS binary built with embedded web UI using Bun 1.4.2.
- Isolated compiled-server smoke loaded the location and agent catalog with all
  required plugins enforced, zero sessions and no inference.
- Older-layout hash-pinned fixtures also passed: 11 tests, 56 assertions, including
  fast completion before observer startup and captured empty history.

For reproduction on a disposable copy of the exact runtime baseline, verify and
apply the runtime patch, install the frozen lockfile in isolation, run `bun run
check` at the root, and run the five core test files (`job`, `tool-subagent`,
`subagent-lifetime`, `session-activation`, `session-native-compaction`) from
`packages/core`. Build from `packages/cli` with `bun run script/build.ts --single
--skip-install --outdir=/staging/built`; retain the web UI. A compatible Intel
Bun/toolchain and installed frozen dependencies are required. Never repair live
dependency links or build over a running release.

The private activation preserved all 1,010 sessions and 93,322 message records;
inbox/pending counts also matched immediately afterward. Authenticated backend,
Tessera location/agent loading, frontend HTTP health and installed hashes passed.
The launcher environment remains free of `OPENAI_API_KEY`. This establishes
startup/artifact preservation, not an end-to-end paid inference recovery test.
No inference was requested and no paused child was automatically resumed. Mobile
reconnection still requires confirmation from the user's device.

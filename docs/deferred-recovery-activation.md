# Registry and notification recovery follow-up

This source change is not live activation authorization. The deployed private
installation has path adaptations and a corrected financial-verification path;
never overwrite those with portable source defaults.

The quota status path retries notices for the caller's direct children, including
historical generations, keeping their original deterministic ID and parent target.
A notice records a past blocked admission; it neither declares a current failure
nor resumes work. Unrelated roots remain excluded.

Registry callbacks use a stable `.flock` inode and the existing configured Python
interpreter's POSIX `fcntl.flock`. The Node process opens the descriptor, passes it
to the short-lived helper, and retains it until the callback finishes. The kernel
releases the lock on process exit; there is no PID reuse, partial lock publication
or persistent reaper marker. This requires macOS/Linux on a local filesystem with
working flock semantics. No Windows support is added. Each registry call incurs
a Python helper startup; keep this cost in mind for high-frequency context hooks.

## Activation and rollback requirements

1. Prepare a private candidate that preserves all current path/financial/security
   adaptations. Verify the exact dispatch-registry, task-dispatch and quota-recovery
   plugin hashes; the fixed Python lock helper is embedded in dispatch-registry
   so the plugin hash covers it too.
   Run the focused tests using the deployed Node/Python versions and verify
   whole-payload provenance. Do not edit loaded plugins or weaken startup hashes.
2. Coordinate a safe point with all workspace owners, including Tessera and garage.
   Check active model/tool/background jobs, child jobs, forms/approvals and queued
   inbox/pending work through the existing supported read/status surfaces. Stop
   admission before replacing the runtime. Repeat idle checks. A user session being
   idle is not proof that all descendants or PTYs have stopped.
3. Back up exact artifacts and manifest, consistent SQLite state, ownership JSON
   and recovery receipts. Preserve all current user work and delivery state.
4. This lock-protocol migration requires all old registry writers to be stopped.
   No hot reload or mixed-version execution. Legacy `.lock`/`.lock.recovery`
   markers fail closed; reconcile them with native state only while writers are
   stopped, retaining a backup. The implementation never deletes these markers.
5. Activate only the specifically approved candidate/pins via the managed launcher
   and supported singleton-service restart. Check the native restart command's
   PTY shutdown behavior before use; arrange a safe terminal boundary too.
   The private native restart handler explicitly shuts down persistent PTYs.
6. Verify startup hashes, loaded entrypoints, session/agent catalog, loopback health,
   preserved sessions/messages and receipts. Inspect ownership/status before any
   explicit same-child continuation; never replay uncertain operations or create
   replacement owners. Exercise a synthetic isolated recovery case without
   spending inference or resuming live work.
7. On regression, stop all new writers, restore the saved artifacts/manifest through
   the same launcher, and retain the latest database/ownership/delivery state.
   Do not delete `.flock` inodes while any process could hold them. Old code ignores
   the stable flock file after a quiescent rollback; leave it intact. Reconcile
   native incomplete generations before explicit continuation.

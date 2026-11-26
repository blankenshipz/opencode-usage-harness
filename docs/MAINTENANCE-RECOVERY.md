# Completion evidence after operator maintenance

A worker can finish useful work after an approved maintenance pause while its
original background-dispatch receipt remains unavailable. The receipt reader
correctly rejects an aborted assistant, interrupted idle and later user message
as an uninterrupted completion chain. Idle status, preserved commits and passing
tests alone do not repair that binding. Do not rerun implementation to manufacture
a receipt, clear the failure flag or mark the worker completed without evidence.

Maintenance operators should preserve the exact current assignment and completion
binding before interrupting a worker, together with interruption acknowledgements
and stable continuation IDs. Prefer a normal same-worker harness continuation
with a new admission binding when that is supported; do not replay an uncertain
control or invent continuation authority.

For already completed work after an explicitly authorized maintenance continuation,
a narrowly audited **administrative maintenance reassociation** is possible:

1. Verify the exact root, parent, child, task, work key, generation, current intent,
   role and model. Require no admission in flight, prior completion receipt,
   active child/descendant, pending input or current compaction.
2. Verify the unique original prompt by marker and full hash. Follow native
   evidence through the exact aborted assistant, interrupted idle and exact
   maintenance continuation ID/hash, without another user prompt, compaction or
   identity switch. Match the independent operator pause/resume receipts.
3. Pin the resumed final assistant and successful idle IDs/sequences. Require
   the unchanged strict completion reader to validate the maintenance prompt
   through that final answer. Missing evidence requires investigation, not repair.
4. Under the existing registry lock, compare the original binding and assignment
   again. Back up state; retain the full original binding, original prompt and
   interruption IDs, continuation ID/hash and operator evidence in a recovery
   audit. Rebind only the completion boundary to the actual maintenance prompt.
   The ownership admission generation can stay unchanged.
5. Collect through the ordinary parent tool. If an operator also records
   collection, reproduce every collection guard and store only the native
   reader's receipt. Recheck the native boundary immediately before saving and
   revalidate afterward. Preserve ownership, scopes, models, permissions,
   financial settings and native messages. Never restore delivered-operation
   ledgers during rollback.

This receipt proves the **maintenance continuation → final answer → successful
idle** leg. The original bridge is administrative evidence, not an uninterrupted
native chain. Registry locking does not make native execution and registry state
atomic. An identical completed repair should be inspected and revalidated rather
than blindly reapplied; changed evidence must fail closed.

This is an operator procedure, not a model-callable grant writer or a new review
waiver. The independent review remains outstanding until it actually runs.

## Restart-safe deploy (`harness-manage deploy`)

`harness-manage deploy <release>` switches to an already staged release under
`<prefix>/releases/` only when nothing is running:

```
harness-manage deploy 0.4.0 --project /path/a --project /path/b --wait 1800 --restart
harness-manage deploy 0.4.0 --dry-run --restart     # verify, print the plan, change nothing
```

0. Preflight, shared by `--dry-run` and a real deploy (since 0.4.1): the project
   check, strict manifest verification of the release (including a vendored
   adapter, see [CLAUDE-SUBSCRIPTION.md](CLAUDE-SUBSCRIPTION.md#installing-the-artifact-and-generating-the-plugin-entry)),
   and verification of the `current` and `previous` releases. If the dry run
   passes, the real deploy cannot fail verification later. `--skip-validate`
   skips this step, and the dry run says so.

1. Idle check: no pending permission asks (`opencode api GET /api/permission/request`
   per project, JSON parsed) and no busy sessions (read-only `session_v2` query on
   `<root>/xdg/data/opencode/opencode.db`). When busy it exits 3 and names what
   is busy; `--wait SECONDS` polls every 15 s first. `--force` skips the refusal.
   The check is repeated inside the prefix lock right before the switch and
   right before `--restart`; busy at either point exits 3 with the switch undone.
2. Backs up `state/config/opencode.json`, `configure-choices.json`,
   `workrelay-bridge.json` and `gateway/mcp.json` to `<root>/backups/deploy-<stamp>/`
   (mode 700) with the old `current`/`previous` names.
3. Points `current` at the release and `previous` at the old `current`, then
   rewrites `guard_entry` in `workrelay-bridge.json` atomically (mode kept).
4. Regenerates the native permission config with the new release's
   `configure.py --models <models> --state-dir <state> --replace` (`--models`
   default `<prefix>/../models.json`, `--state-dir` default `<prefix>/../state`).
   A failure restores the links and config from the backup (exit 5).
5. With `--workrelay-dir DIR --workrelay-ref REF`: `git -C DIR fetch origin` and
   `git -C DIR merge --ff-only REF`. Unrelated uncommitted files are kept; if they
   conflict or it is not a fast-forward, only this step is aborted with a message.
   Nothing is ever stashed or discarded.
6. With `--restart`: stops the gateway (`gateway/gateway.pid`), runs
   `opencode service stop` and `start`, and runs `gateway/start-gateway.sh`.
   If that fails, `current` is rolled back to the old release (exit 5).
7. Warms each project's plugins and verifies the release path is loaded. Since
   0.4.3 it first waits for the restarted service: `GET /api/plugin` is retried
   every 2 s, for up to 60 s in total across all projects, until it returns
   parseable JSON. One more call then reports the loaded plugins, and it keeps
   polling until the release path appears: within the shared 60 s, and for at
   least 10 s per project once that project's `/api/plugin` has answered (so a
   service that comes up late in the window still gives later projects time to
   report). Exit 4 only when a project still does not load it after the wait.
   Each call has its own 30 s timeout, so the worst case is somewhat longer than
   60 s, but always bounded. (The 0.4.1 deploy exited 4
   because both calls ran before the service was up; a minute later all projects
   had loaded the release.)
8. Resume hook: by default `python3 -m workrelay.cli --config <bridge>
   resume-interrupted --owner <owner> --restart-id deploy-<stamp>-<release>
   --all-interrupted` (owner: `--resume-owner` or `authorized_owner` in the bridge
   config; `PYTHONPATH=<workrelay>/src`). It runs only if its `--help` succeeds.
   `--resume-command` or `$HARNESS_DEPLOY_RESUME_COMMAND` override it; `""` disables.
   It runs after step 7, so since 0.4.3, on a successful warm check, the service
   has answered `/api/plugin` before the hook starts. The hook also runs when
   step 7 ends in exit 4 (including when the service never answered), as in 0.4.2;
   in that case re-run it by hand once the service is up. The 0.4.1 hook exit 2 (a workrelay `BridgeError`) was
   most likely the same "service not up yet" cause. The hook itself is unchanged
   and is not retried; re-run it by hand with the same `--restart-id` if needed
   (it is idempotent per root).

`<root>` defaults to the parent of the prefix; commands run with `<root>/env.sh`
sourced and their output is never printed. Projects come from `--project` or
`$HARNESS_DEPLOY_PROJECTS` (colon separated), else from `full_auto_projects` in
`<state>/config/configure-choices.json`; with none found it refuses unless `--force`. Roll back with `harness-manage rollback`.

## Commit attribution

`harness-manage install-commit-hook <repo>` installs a `prepare-commit-msg` hook
(source: `scripts/git-hooks/prepare-commit-msg`) that appends `Agent:`,
`Harness-Role:` and `Workrelay-Session:` trailers from `HARNESS_AGENT`,
`HARNESS_ROLE` and `WORKRELAY_SESSION_ID`. Unset variables are skipped, existing
trailers are not duplicated, and author and committer are never changed. An
existing different hook is kept as `prepare-commit-msg.harness-chained` and run
first. `plugins/v2/agent-attribution.mjs` sets those variables for harness shells
(OpenCode `shell` `create.before` hook); values already in the environment win.

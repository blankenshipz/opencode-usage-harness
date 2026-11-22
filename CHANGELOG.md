# Changelog

## 0.3.4 — protected reads, source files named like secrets (r37)

Two fixes from the r36 log review.

- **Protected locations ask under full-auto** (`plugins/v2/full-auto.mjs` `protectedLocation`, used by `auto-permission.mjs` `credentialPath` and the full-auto shell check). The 0.3.3 read-only rule (`full_auto_read_only_external`) allowed reading these without asking; no session did. Read tools and read-only shell (`cat`, `sqlite3 … .dump`, `ls`, `cp`, `<` input, `cd` into them, also behind literal variables and `bash -c`) now ask for:
  - browser profile data: files named `Cookies`, `Login Data`, `Login Data For Account`, `Web Data`, `Local State` (and `-journal`/`-wal`/`-shm`), Chrome profile directories (`Default`, `Profile N`, `Guest Profile`, `System Profile`) under a `chrom*`/`user-data`/`*-profile*` directory, and anything under a directory that holds a `Local State` file;
  - `/home/box/work/agent-profiles/**` and any `*profile*` path under `/workspace/browser-probe`;
  - the harness install `/home/box/work/ocharness/**` (`workrelay-bridge.json`, `gateway/`, `claude-config/`, `xdg/` with the OpenCode DB, `state/`), plus the configured state dir (and its parent install when it is named `state`), `$OCH`, `$CLAUDE_CONFIG_DIR` and `HARNESS_PROTECTED_DIRS` (colon list).
  - Still readable: `<state>/check-receipts/**` (sessions read their own test receipts), the harness code `<install>/harness/**` (sessions run `harness/releases/<v>/src/check_receipt.py`) and OpenCode shell-output files `<install>/xdg/data/opencode/shell/**`.
  - `grep`/`codesearch` on a directory that contains a protected location or a credential directory (`/home/box/work`, `/workspace`, `~`) ask too.
  - The garage-server `.env` exemption is unchanged.
- **Source files named like secrets are code** (`shell-guard.mjs` `isSecretPath`, `configure.py` `SECRET_CODE_SHELL_ALLOW`): a dotted name containing `secret`/`credentials` with a code extension (`.py .ts .tsx .js .jsx .mjs .cjs .kt .swift .go .rb .java`, not a dotfile) is not a secret path, so `git add mobile/src/__tests__/screens/AgentSearchCredentials.test.tsx` and `backend/app/agent_search/credentials.py` auto-allow with no native second ask. This was all 4 asks since 0.3.3. Native permissive rules gain allows for `*credentials*.<ext>` and `*secret*.<ext>` after the secret asks; the other secret asks (`*.env*`, `*.pem*`, `*.key*`, `*auth.json*`, …) are repeated after them, so `cat .env x.py` still asks natively. `.env*`, `credentials.json`, `client_secret.json`, `secrets.yaml`, `*.pem`, `*.key`, bare `credentials`, `.secrets.py` and anything under `secret*/`/`credentials*/` directories still ask. The guard now also re-asks when a whole command the rules allow names a real secret path (`cat credentials.json x.py`).
- Tests: new `tests/v2-protected-reads.test.mjs` (replays the 2 r36 commands through the guard and the native rules; protected reads by read/glob/grep/list and shell; check-receipts still allowed); native rule cases in `tests/test_configure.py`.

## 0.3.3 — permission waits (r35)

72 permission asks cost 40.8 h of waiting in r34. Replaying all 72 through 0.3.3 logic: 67 would auto-allow, 5 still ask (see `docs/SHELL-PERMISSIONS.md`, "0.3.3").

- **Full-auto shell check** (`plugins/v2/full-auto.mjs`):
  - literal shell variables are expanded before path checks (`D=/repo/.review/x; cmd > $D/out`, `for i in 1 2; ... > out$i`). A write target whose unknown variable follows a literal directory strictly inside the project (`.review/verify-$TS/revision.txt`) is judged by that directory. Deletes still need literal (or literally assigned) targets;
  - per-segment working directory: after a top-level `cd T`, segments joined by `&&` (and `&& ( … )` subshells) run in T only, so `cd backend && (ruff . > ../.review/x)` is inside the project. `;`, newline, `||` and `&` fall back to the union of directories, as before;
  - relative redirects that resolve into `/tmp` (`cd /tmp/opencode/x && cmd > out`) are scratch writes;
  - **new asks:** `sudo`/`doas`/`su`/`pkexec` and system service changes (`systemctl` verbs other than reads, `service X <verb>` other than `status`), local or over ssh, for every unit. Before 0.3.3 full-auto allowed these;
  - **new per-project `no_push_deploy`** (`configure.py --full-auto-no-deploy DIR`; set for yrdsale, Phase 1 rule): `git push` (any form), `gh pr create|merge`, `gh release create`, `railway|fly|vercel|eas|netlify|heroku|… deploy/up/submit/…`, `docker push`, `npm publish`, `scp`/`rsync` to a host all ask.
- **Secret paths** (`shell-guard.mjs`): report files of a secret *scan* (`secret-scan.txt`, `secret-hits-lines.txt`, `secrets_scan-*.out`) are not secret paths; `secrets.txt`, `client_secret.json` and anything under a `secret*` directory still are. This was 7 verifier asks.
- **Auto-permission** (`plugins/v2/auto-permission.mjs`):
  - the `background_process` decline now means a real background job (`cmd &`, `nohup`, `setsid`, `disown`, `$!`). It used to match any `&`, so `&&` chains and `2>&1 | tee .review/…` were declined (10 of 10 logged declines);
  - full-auto `external_directory` rule: read-only tools (`read`, `glob`, `grep`, `list`, …) may look outside the project anywhere except credential/secret paths and other projects' uncommitted files (a sibling git repo's path must be tracked and clean, checked with read-only `git --no-optional-locks status`). A shell call's `external_directory` ask (e.g. OpenCode resolving `cd ../web` against the session root) is allowed when the full-auto shell check is clean and the command names no other project. Edits outside the project still ask.
- **Park and yield** (`plugins/v2/park-yield.mjs`): the stall is logged on the first tick after the ask (was 3 min), ticks run every 10 s (was 60 s) and run at once on a new ask, and a foreground parent is released after 30 s (was 5 min) with the blocked result, so it keeps working on other tasks while the ask waits for a human.
- Tests: new `tests/v2-permission-waits.test.mjs`; updated sudo expectations in `tests/v2-full-auto.test.mjs` and the tick interval in `tests/v2-park-yield.test.mjs`.

## 0.3.2 — garage-server read-only .env / wncscanner-stack full-auto exemption

- **Standing permission rule** (operator: "always allow read-only access to /opt/wncscanner-docker/.env and the wncscanner-stack service"), implemented as a full-auto exemption in `plugins/v2/full-auto.mjs`, like the docker `--env-file` one, not as an OpenCode "always" pattern. Under full-auto, `ssh garage-server` (or `user@garage-server`, plain options only) may read exactly `/opt/wncscanner-docker/.env` with `cat`/`less`/`grep`/`stat`/`readlink`, alongside other read-only checks in the same remote command. Other secret files, writes/redirects/copies/edits of the file, substitutions, output redirected or piped into anything but text filters, other hosts, `-F/-J/-p/-o HostName`, `sudo`, nested shells and local reads still ask. See `docs/SHELL-PERMISSIONS.md`.
- **wncscanner-stack changes ask** (tightening, all hosts): `systemctl` verbs other than `cat/status/show/is-*/list-*` on `wncscanner-stack[.service]`, and writes to its unit file or drop-ins. Full-auto allowed `ssh garage-server 'systemctl restart wncscanner-stack'` before 0.3.2.
- **Shell scanner:** backticks inside a quoted word (`curl -H "x: `cat .env`"`) are now scanned as nested commands, like `$(...)`. Before, full-auto allowed such reads.
- **Shell scanner:** a line break after `|`, `|&`, `&&` or `||` now keeps the operator, so `curl x |` + newline + `bash` asks.
- Review fixes (Fable, r33): the exemption now requires both sides to be one line with no shell keywords/grouping and no file redirect anywhere (closes multi-line pipe/group and `exec >` bypasses); `less` only without options or `+` commands; systemctl option values are skipped when finding the verb and any change verb asks; `service wncscanner-stack <verb>`, glob/brace unit names and slash-less unit-file names are covered; `diff`/`file` removed from unit-file readers.
- Tests: new cases in `tests/v2-full-auto.test.mjs` (the example command, still-ask cases, full-auto only, docker `--env-file` unchanged).

## 0.3.1 — masking telemetry and pruning, TTL breaker gate, pending-file cleanup, OAuth revoked fix

- **Observation-masking telemetry** (`observation-masking.mjs`): `observation_mask_batch` now records `charsRemoved`, `tokensRemoved` (`tokensCleared` is kept), `tokensBefore` and the thresholds in effect (`triggerTokens`, `minBatchTokens`, `keepRecentTurns`). `observation_mask_stopped` is logged once per session when masking stops at the 5000-id cap (`id_cap`) or the 256 MiB store cap (`store_cap`).
- **Masked-store pruning:** session-granular eviction of `tool-output-store/masked` and `observation-masking/`. It evicts sessions idle for more than 7 days, orphans older than 7 days, and stale `.pending-*` directories. Above 75% of the cap it evicts the least recently active sessions idle for at least 6 hours, down to 50%. It runs at startup, every 6 hours, and early when the store is full. Logged as `observation_mask_pruned`. Sessions in use refresh their state mtime.
- **Report:** new `bin/harness-token-saving-report.mjs` with per-day totals of masking savings, stops and prunes, 1h-TTL events, breaker trips and fallbacks, and auth recovery. `harness-daily-rollup.mjs` adds a `tokenSaving` section.
- **1h TTL gated on the circuit breaker** (known gap from 0.3.0): the breaker is shared per process and persisted for 24 hours in `<state>/token-saving/ttl-breaker.json`. While it is tripped, parents use the default 5m TTL and the 5m cache-keep window, and one `parent_cache_ttl_fallback` is logged per trip and process.
- **Permission-pending files:** `state/permission-pending/<loc>.json` is deleted when its pending map becomes empty. At startup, files that are already empty are swept. Each file is moved aside atomically and restored if it gained an entry in the meantime, so a file with pending entries is never deleted. A sweep that removes files logs `pending_files_swept`.
- **Claude OAuth "access token has been revoked"** (2026-11-21T02:06:40Z): the root cause was in the vendored adapter. The credential refresh that OpenCode runs through the adapter did not update the adapter's 30-second request cache, so requests were signed with the token the refresh had just revoked. New `compat/claude-auth-3.0.0-auth-recovery.patch` (plus its baseline):
  - the refresh now updates the cache;
  - a 401 gets exactly one retry, for the same account only;
  - a `claude_auth_recovery` event is logged without token values.

  The OpenCode runtime is unchanged.
- Tests: `tests/v2-r32-masking-telemetry.test.mjs`, new cases in `tests/v2-token-saving.test.mjs` and `tests/v2-permission-reevaluate.test.mjs`, and the adapter test `src/harness-auth-recovery.test.ts` (in the patch).

## 0.3.0 — token-saving strategies (cache-aware continuations, 1h parent TTL, observation masking, effort map)

All four are on by default. They are configured in `<state>/config/token-saving.json` (hot-reload) with `HARNESS_TOKEN_SAVING` / `HARNESS_CACHE_KEEP` / `HARNESS_PARENT_CACHE_TTL` / `HARNESS_OBSERVATION_MASKING` / `HARNESS_EFFORT_MAP` `=off` kill switches, and log decisions to `<state>/telemetry/token-saving.jsonl`. See README "Token-saving strategies" (sources, caveats, how to measure). Research: r29.

- **K, cache-aware continuations** (`dispatch-routing.mjs`): a continuation keeps the child's current model when the child is running, or when its last completed response is younger than 5 min (1 h for router/coordinator roles). This covers tier demotion, pacing and policy re-selection. The suppression is recorded as `routing.source="cache_keep"` and `routing.cacheKeep`, and logged as `model_switch_suppressed`. Explicit `model`, `resetModel` and required cross-family reviews still switch. Right after a completed same-child compaction the route is re-evaluated like a new dispatch (`routing.postCompactionReroute`).
- **B, 1h prompt-cache TTL for parents** (`parent-cache-ttl.mjs`). This supersedes the 0.2.x note "1h cache TTL not enabled": the context hook still cannot set the request cache policy, but the runtime's `session.http.request` hook sees the final Anthropic body. For router/coordinator `primary` requests the existing `cache_control` breakpoints are rewritten to `ttl:"1h"` (same positions and count). Workers stay at 5m. Fail-safe: no hook, non-JSON body, or the subscription adapter already applied → unchanged and logged once; a TTL-related 400 → turned off for the process.
- **A, batched observation masking** (`observation-masking.mjs`): above about 80k estimated context tokens, old tool results (not calls, not the last 8 turns, not control records) are replaced by placeholders that point to originals saved under `tool-output-store/masked/`. This happens only in batches of at least 30k tokens. The masked set persists per session and is re-applied byte-identically. `cache-drift` reports the batch as `masking_boundary` (also accepted by `harness-metrics`).
- **C, effort from routing complexity**: new dispatches on the configured or paced model use scout/quick-builder → `low`, STRONG/MAXIMUM → `high`, `routine` → `low` and `complex` → `high` (`standard` keeps the configured effort). Only a same-model variant listed in the catalog is used. High-risk work is never lowered, and explicit models, policy candidates, reviews and continuations are unchanged. Recorded in `routing.effortMap`.
- Tests: `tests/v2-token-saving.test.mjs`, plus a masking-reason test in `tests/test_cache_drift_metrics.py`.
- Review fixes (83b7b78): masking accepts an `Original:` pointer only from the harness compression marker; compaction requests get the same masks; the post-compaction reroute stays on the same provider and keeps taskFit; the 1h warm window applies only to Anthropic models; no cache keep when the current model's quota is unavailable; tier effort mappings only raise effort and never lower high-risk work. Known gaps: masking stops quietly at its id/store caps (no prune or telemetry yet), and the 1h TTL is not gated on the TTL circuit breaker.

## Unreleased — secret-path checks match file arguments, not bare words

- Approved 2026-11-20 ("narrow the key and secret matches so read-only checks stop asking"); applies to every project. `isSecretPath` only matches a path-shaped token (no `|()\\^'"` or spaces): `.env`/`.env.*` (templates excepted), `*.pem`, `*.key` as the final extension, `auth.json`, `credentials`, `id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, dotted names containing secret/credentials (`client_secret.json`, `.git-credentials`), anything under a `secret*`/`credentials*` directory, and non-public files under `.ssh/`. Bare words (`MY_SECRET`, `secret_key`, `token`) no longer match.
- New `secretWords`/`shellSecretReasons`: grep/egrep/rg/ag/ack/`git grep` patterns and `-e` values, sed/awk scripts, and the `ssh`/`scp`/`sftp -i` identity are not file arguments (`-f` pattern files are). Quoted literals inside code words and heredoc bodies are checked (`python3 -c "open('.env')"` asks; `d.keys()` does not). Nested `sh -c`/`eval`/heredoc-to-shell and `ssh` remote commands are checked as before.
- The native `SECRET_SHELL_ASK` wildcards (`*.key*`, `*secret*`, ...) are unchanged in configure.py; the guard's evaluate hook now drops a shell ask that only those wildcards raised when the command names no secret path (`env | grep -viE "secret|token|key|pass"`, `ssh host 'python3 - <<EOF … d.keys() … EOF'`, `grep -ri secret src`). In full-auto projects the evaluate re-check uses the same argument-aware check instead of the wildcards. Secret paths the wildcards miss (`~/.ssh/id_rsa`) now ask under rules that would allow them. The docker `--env-file` exemption stays full-auto only. Hot-reloads with the plugin.

## Unreleased — full-auto: amends of unpushed feature-branch commits

- Full-auto projects no longer ask for `git commit --amend` when every amend in the command is a top-level git commit in a repo inside the project whose branch is not main/master and whose HEAD is on no remote-tracking branch (`git branch -r --contains HEAD` empty; errors count as pushed). Repo resolution reuses the branch-gated commit plan (`cd dir &&`, `git -C`, same-directory wrappers; branch/repo changes in the command keep the ask). Amends of pushed commits, on main/master or detached HEADs, nested in `sh -c`/`eval`/heredocs/`ssh`, force pushes, rebases and other rewrites still ask. The permissive policy outside full-auto is unchanged. Hot-reloads with the plugin; no configure change.

## Unreleased — router back on Opus

- `harness-router` returns to the strong tier (Opus), reverting only the router model change from 064ae04. The Haiku quick-builder routing (prompt guidance and the `routine_mechanical` dispatch path), timed-reminder cache fix, full-auto and agent commit identity are unchanged. Takes effect after `configure.py --replace`.

## Unreleased — router on Sonnet, Haiku quick-builder for mechanical work, agent commit identity

- `harness-router` uses the balanced tier (Sonnet) instead of strong (Opus); deep-debugger, verifier, reviewer and architect stay strong. Router/coordinator prompts name `harness-quick-builder` for routine, normal-risk mechanical edits.
- `dispatch-routing.mjs`: a builder dispatch with taskType `mechanical`, complexity `routine`, risk `normal` goes to the quick-builder model at any quota pace (source `routine_mechanical`), unless a model is explicit/remembered, quick-builder is on another provider, or strict task-fit excludes it. Pace demotion, routing-policy candidates, scoped-quota checks and continuation affinity are unchanged.
- Takes effect after `configure.py --replace` regenerates the profile (router model and prompt guidance); the mechanical demotion is skipped when routing policy v1 is enabled and the FAST scope is exhausted, so the configured builder model is used instead of a scope error.
- docs/SETUP.md: set the operator's git identity for agent commits (GIT_AUTHOR_*/GIT_COMMITTER_* in the launcher env plus per-project `.git/config`).

## Unreleased — timed reminders persisted, not a transient cache-breaking tail

- Root-progress and work-checkpoint reminders are now persisted once as a synthetic user message (persist only; it is admitted at the next step boundary, so no transient tail; a not-yet-admitted copy is not re-persisted for 15 min; dedupe matches string or part content; transient user-message fallback only when persistence is unavailable/fails) (`deliverTimedReminder`, like native Plan-mode reminders) and appended to the current request at the same position. They were a transient tail `role:'system'` message (r6, 34a572c); the runtime's auto cache policy puts its only message breakpoint on the last message, so the reminder carried it, the next step's prefix diverged there, and every step while a reminder was due rewrote the whole history and read only the tools+system prefix (r12: builder q0hYa8 22:47:29-22:48:55, read 10,836 / write 30-38k per step, back to read 49k once the reminder cleared). A reminder already in the last 30 messages is not repeated. Persistence failures never block the step.
- 1h cache TTL not enabled: the OpenCode 2.0.30 context hook cannot set the request cache policy or TTL (requests use the 5-minute auto policy), per-part hints need the runtime's CacheHint class, and the top-level `cache_control` passthrough would add a fifth breakpoint. 1h writes also cost 2x base input vs 1.25x for 5m.

## Unreleased — per-project full-auto permission profile

- Approved 2026-11-19 for wncscanner ("basically full auto approve on most actions"). `configure.py --full-auto-project DIR` (repeatable; `--no-full-auto-project DIR` removes) persists `full_auto_projects` (`[{directory, data_dirs}]`) in `configure-choices.json`. The generated profile does not change; `plugins/v2/full-auto.mjs` reads the list at runtime (mtime-cached, so edits hot-reload). Other projects keep the normal policy.
- Inside a full-auto project the shell guard's evaluate hook downgrades native asks to allow: shell asks for calls it inspected in `execute.before` and found safe (session + tool-call id; fail closed), and `external_directory`/`read`/`edit` asks whose resources resolve inside the project or a data dir. Deny rules (secret read/edit denials, read-only roles) are untouched; reevaluation probes are not downgraded, so already-pending asks stay with a human.
- Allowed there: git add/commit on main/master (no branch gate), stash, reset (soft/mixed), checkout/switch/merge/pull/restore, plain push, ssh/scp/rsync deploys, docker/compose, kill, sudo, chmod/chown -R, `sh`/`bash -c`, eval, wrapped commands, and rm/find -delete/rsync --delete whose targets resolve strictly inside the project or a data dir.
- Still ask there (`fullAutoShellCheck`, on every segment, wrapper, `$(...)`, `sh -c`/`eval` body, heredoc or here-string fed to a shell or ssh, and ssh remote command): force/delete/mirror/prune pushes and branch/tag deletes; rebase, `commit --amend`, filter-branch/filter-repo, `reset --hard`, `reflog expire/delete`, `gc --prune`, `git prune`, `update-ref -d`; deletes whose targets are outside the project (symlinks resolved), the project root itself, `.git`, non-literal (`$VAR`, `{}`), from `xargs`, or `--no-preserve-root`; remote deletes of `/`, a top-level dir or the remote home; dd/mkfs/shred/wipefs/partitioners and `/dev` block devices; secret-looking paths; truncating redirects outside the project (except /tmp, /dev/null); pipes into a shell; `ssh -o ProxyCommand/LocalCommand`.
- Full-auto only: the value of docker's `--env-file` (`--env-file FILE` / `--env-file=FILE` after a `docker`/`docker-compose` word, also behind sudo, `sh -c`, `&&` chains and ssh remote commands) no longer counts as a secret-looking path, so deploys such as `docker compose --env-file ../.env up -d` run without a prompt (approved 2026-11-19). `docker` must be in command position (after separators, assignments, simple wrappers, `ssh host` or `sh -c`), so `cat -- docker --env-file .env` still asks. Docker can itself print the values (`compose config`, `run … env`); accepted. Other words in the same command are still checked (`docker compose --env-file .env up && cat .env`, `docker cp secrets.pem …` ask), as are cat/cp/scp/rsync/base64 and other reads of secret files and `--env-file` on non-docker commands. Other projects are unchanged.
- New `tests/v2-full-auto.test.mjs` (~150 commands through the plugin with the live permissive rules, path actions, config reload) and a configure test.

## Unreleased — git add/commit allowed on feature branches under the permissive shell policy

- Approved 2026-11-19: agents may `git add`/`git stage`/`git commit` without a prompt when the repo's current branch is not main/master. On main/master, a detached or unresolvable HEAD, or any branch/directory smuggling, the ask stays.
- Fail closed: `configure.py` keeps a native ask (`BRANCH_GATED_ASK`: `git add*`, `git stage*`, `git commit*`), and `shell-guard.mjs` downgrades it to allow only for a call whose every add/commit it resolved (session dir + `workdir`, `cd dir &&`, `git -C`) to a feature branch with `git symbolic-ref -q HEAD` (2 s timeout). Without the guard, everything asks as before.
- Smuggling asks: `git checkout/switch/symbolic-ref/worktree/...` or `git branch -m`/config writes in the same command, `GIT_DIR`/`GIT_WORK_TREE`/other `GIT_*` env, `--git-dir`/`--work-tree`, non-identity `-c`, writes to `.git/`, `cd` outside a plain top-level `&&` chain (`;`, `||`, `|`, subshells, functions, `$VAR`, `cd -`, `pushd`, `CDPATH`), `env -C`, `find -execdir`, `sh -c`.
- Still ask on every branch: `git commit --amend` (also abbreviated: static `git commit *--am*`), wrapped add/commit, `git branch -d/-D/--delete` (newly also `-d`, `--del`, `-dr`; previously only `-D` asked), force/delete pushes (the guard now also catches abbreviations such as `--del`, `--mirr`), reset --hard, rebase, stash and the rest.
- The guard now also checks `git -C dir <sub>` and wrapped git invocations against the rules in their canonical `git <sub>` form (`git -C x reset --hard` used to be allowed).
- New `tests/v2-shell-guard-commit.test.mjs` (real main/master/feature/detached repos, live configure rules, ~130 commands); `tests/test_configure.py` updated (`timeout 5 git add` now asks).

## Unreleased — plain git push allowed under the permissive shell policy

- Approved 2026-11-19: harness agents may `git push` without a prompt. Plain `git push`, `-u`/`--set-upstream`, `origin <branch>`, `--tags`, also behind wrappers, are allowed.
- Still ask: `--force*` (incl. `--force-with-lease`), `-f`, `+refspec`, `:ref` and `--delete`/`-d` deletes, `--mirror`, `--prune`, `--receive-pack`/`--exec` (`GIT_PUSH_ASK`, also behind every wrapper and after `--`), plus every other existing ask (reset --hard, rebase, commit, ...).
- `shell-guard.mjs` `gitPushDanger` checks every segment of the raw command, including compound, nested `$(...)` and wrapped ones. It forces an ask for forms wildcards miss: `-uf` clusters, quoted refspecs, `git -C d push -f`, `/usr/bin/git`, `-c alias.*`/`remote.*.push`/`push.*`, `git config` writes of those keys, and `GIT_CONFIG_*` env. `tests/v2-shell-guard-push.test.mjs` checks it against the live configure rules.

## Unreleased — wrapped dangerous commands ask under the permissive shell policy

- Permissive (`shell *` allow) already allows read-only git, check_receipt.py-wrapped test/lint commands, test runners and linters. The 2026-11-19 asks for those came from the earlier allowlist policy, /tmp and receipts, all fixed since.
- Hole closed: dangerous commands behind a wrapper matched only the wrapper's prefix and were allowed. Examples: `check_receipt.py -- git push`, `env X=1 git commit`, `xargs git push`, `timeout 5 kill`, `nohup git reset --hard`, `find -exec rm`.
- `WRAPPED_COMMAND_ASK` now asks for push/commit/reset/rebase/clean/restore/stash, recursive or forced rm, sudo/doas, kill, dd, mkfs, shred, chmod/chown -R and shells. It covers them after env/xargs/timeout/nice/nohup/command/time/stdbuf/setsid/exec/builtin/flock/parallel, after `--`, and for `find -exec/-ok/-execdir/-okdir`. The patterns are word-delimited (`timeout 5 git add` stays allowed).

## Unreleased — byte-stable system prompt

- Live cache-drift telemetry (2026-11-19): all 18 `drift_observed` rows were `system` drift, in add/remove pairs. The root-progress (router/coordinator) and work-checkpoint (children) reminders were pushed onto `event.system` when due and dropped a turn later, so each one rewrote the whole cached history twice (50–270k tokens).
- These timed reminders now go in a system-role update appended after the last message (`appendTailUpdate`), as native Plan-mode reminders do. The system block stays byte-stable. The mid-run continuation stays in system: it changes only at a completed compaction, where history is rewritten anyway.
- New test: generating the profile twice (and in another state dir) gives byte-identical agent prompts with no timestamps or state paths.
- Remaining between-session drift is per deploy (agent prompt edits, the native CodeMode tool catalog) or per workspace (native environment/date blocks).

## Unreleased — compression coverage

- Live telemetry (2026-11-19): 0 of 1,252 candidates compressed, 57% `protected_tool`, 37% `below_minimum`. The protected bucket was almost entirely `read`/`edit`/`write`.
- Native grep output from OpenCode 2.0.30 (blank line after every match) is now parsed; previously `search-preview`/`path-prefix` never fired on live grep results.
- Protected tools narrowed to `read`, dispatch/intent/outcome/artifact/contract control tools, `check_prepare`/`check_status` receipts and `large_file_*`. `edit`/`write`/`patch` are no longer protected (their outputs are tiny). Harness diagnostics JSON tools (`harness_health`, `subscription_quota`, `codex_quota`, `model_status`, `repo_identity`) are compressible JSON. CodeMode calls into protected tools get lossless projections only.
- Lossless projections start at 2 KiB (lossy keep 4 KiB). New lossless `grep-lines`. Shorter retrieval marker (~300 fewer characters per projection).
- Replaying the day's 1,379 real tool results: 24 projections prepared, about 104k characters saved (before: 0).

## Unreleased — check receipts readable outside the state dir

- `configure.py` always emits a global `external_directory` allow for `<resolved state dir>/check-receipts/*`, so agents in a project outside the state dir can read check receipts without a prompt. It does not allow the rest of the state dir, it is not persisted, and secret denials still apply.

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

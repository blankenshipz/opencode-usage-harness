# Shell permissions

`configure.py --shell-policy allowlist|permissive` selects how shell commands are
approved. The choice is stored in `$HARNESS_STATE_DIR/config/configure-choices.json`;
a later `configure.py --replace` without the flag keeps it. New installs default to
`allowlist`.

| Policy | Generated global shell rules |
|---|---|
| `allowlist` (default) | Global `* ask`, then allows for exactly `pwd`, `git status*`, `git diff*`, `git log*`, `npm test*`, `npm run test*`, `pytest*`, `python3 -m pytest*`, `go test*`, `gofmt *`. Anything else asks. |
| `permissive` | `shell *` allow, followed by the `DANGEROUS_SHELL_ASK` ask list in `configure.py`: recursive `rm`, `sudo`/`doas`/`su`, force/delete/mirror/prune `git push` (`--force*`, `-f`, `+refspec`, `:ref`, `--delete`/`-d`, `--mirror`, `--prune`; plain `git push`, `-u`, `origin <branch>` are allowed, and `plugins/v2/shell-guard.mjs` also asks for forms wildcards miss: `-uf`, quoted refspecs, `git -C d push -f`, `-c alias.*`/`remote.*.push`, `git config alias.*`, `GIT_CONFIG_*` env, and any wrapper or compound), `git reset --hard`, `git clean -f`, `git checkout -- …`/`.`/`-f`, `git restore`, `git rebase`, `git commit`, `git stash`, `git branch -D`, `--force`/`-f`, `filter-branch`, `update-ref -d`, `chmod`/`chown -R`, bare or flagged `sh`/`bash`/`zsh`/`dash` (pipe-to-shell, `-c`), `eval`, `xargs … rm`, `find -delete`, `dd`, `mkfs`, `shred`, `kill`/`pkill`/`killall`, and secret-looking paths (`*.env*`, `*auth.json*`, `*.pem*`, `*.key*`, `*credentials*`, `*secret*`, `*financial-policy*`, `*external-write-grants*`). Env templates (`.env.example`, `.env.sample`, `.env.template` as a whole word, any directory) are allowed after the secret asks and before the command asks, so `rm -rf .env.example` still asks. |

The last matching rule wins. With either policy, the read-only roles (router,
coordinator, scout, architect, reviewer) keep an agent-level `shell * deny`, and
builder roles are told to write files with edit/write rather than shell redirection.
Native permissions are lexical rules, not a sandbox. For example, the contents of
`bash -c '…'` are not parsed, so that form always asks.

## Raw-command shell guard

OpenCode 2.0.30's bash parser (`shell/parse.ts`) attaches a redirect at the end of a list
or pipeline to the whole list. As a result, `cd x && cat >> .env <<EOF` produces the
permission resource `cat`, and `cmd 2>&1 | tail` loses `2>&1`. A bare `> f` produces no
command and therefore no permission check. The task-outcomes plugin
(`plugins/v2/shell-guard.mjs`) checks the raw `shell` command in `tool.execute.before`.
It forces a native permission ask, using the full raw command as the resource, when:

- an unquoted redirect (`>`, `>>`, `>|`, `&>`, `N>`, `<`, `>&file`) targets a secret-looking
  path (`.env`, `.env.*`, `*credentials*`, `*.pem`, `*.key`, `auth.json`, `*secret*`,
  `*financial-policy*`, `*external-write-grants*`). Env templates (`.env.example`,
  `.env.sample`, `.env.template`, case-insensitive basename) are not secret.
- a segment that the configured rules allow only through an env-template exception still
  matches an ask/deny rule, or names a secret-looking path, once its template words are
  removed (`cp .env.example .env`, `diff .env.example .env.local`)
- a redirect has no command word (`> f`, `true; >> log`)
- in a compound command (a list, a pipeline, a subshell or `$(…)`), a segment that carries
  a redirect matches an explicit `shell` ask rule. The parser would have dropped that
  redirect. An explicit `shell` deny rule blocks the call.

The guard handles quotes, `\` escapes, `$'…'`, comments, heredoc bodies (including
`<<-`), here-strings, fd duplication (`2>&1`, `>&2`, `2>&-`) and process substitution. Those
forms never trigger it on their own. A guarded request carries `metadata.harnessShellGuard`.
A plugin `permission` `evaluate` hook upgrades its effect from allow to ask, so it reaches a
human even under `shell *` allow. It is saved with `save: []`, so "always" does not
persist it. If the permission API is missing, the guard blocks the call with an
explanation instead. A guarded command can ask twice when the native rules also ask for
a parsed segment. That is intentional.

## Pending asks after a config reload

OpenCode 2.0.30 re-evaluates pending asks only after an "always" reply. An ask raised
under older rules therefore stays pending after a more permissive hot reload. The
task-outcomes plugin (`plugins/v2/permission-reevaluate.mjs`) tracks
`permission.asked`/`permission.replied` events. About 1.5 s and 6 s after `config.updated` or
`agent.updated`, it re-checks each pending request of each known session (via
`permission.list({sessionID})`). The check is a native `permission.assert` probe, with the
agent that issued the tool call when known. An evaluate hook turns a probe's ask into a
deny, so a probe never creates a new ask. The plugin replies `once` only when the current
rules allow the request. Requests that are still ask or deny, requests raised by the shell
guard, and requests evaluated while the agent registry is reloading (missing agents
evaluate as deny-all) are left for a human.

To inspect pending asks manually, use the per-session endpoint
`GET /api/session/<sessionID>/permission`. The global `GET /api/permission/request` list is
location-scoped and returns `[]` when queried from another directory. Answer with
`POST /api/session/<sessionID>/permission/<requestID>/reply` `{"decision":"once"}`.

## Repository identity without shell

Read-only roles have no shell. The `repo_identity` tool (`plugins/v2/repo-identity.mjs`,
allowed in the generated profile) returns the working directory, git toplevel, branch,
HEAD and a dirty summary (staged/modified/untracked/conflicted counts, first 20 paths). It
runs fixed `git` argv without a shell, with `--no-optional-locks`, `core.fsmonitor=false`
and `GIT_OPTIONAL_LOCKS=0`, so it cannot write the index or run repository-configured
fsmonitor commands.

## /tmp scratch space

`configure.py --allow-tmp-scratch` (persisted as `tmp_scratch` in `config/configure-choices.json`; `--no-allow-tmp-scratch` turns it off) adds a single global rule `{"action":"external_directory","resource":"/tmp/*","effect":"allow"}`. Without it, any access outside the workspace (including scratch files under `/tmp/opencode/...`) raises an `external_directory` prompt, which stalls headless runs. The rule does not relax read/edit secret denials, shell asks, or agent-level denies.

## Check receipts

`configure.py` always adds one global rule `{"action":"external_directory","resource":"<state-dir>/check-receipts/*","effect":"allow"}`, with `<state-dir>` the absolute, resolved `--state-dir` (default `HARNESS_STATE_DIR`, else `~/.local/state/opencode-usage-harness`). Agents can read the check receipts the harness writes even when the project lives outside the state dir. It is not a persisted choice. The rest of the state dir still prompts. Secret denials, shell asks and agent-level denies still apply.

# Shell permissions

`configure.py --shell-policy allowlist|permissive` selects how shell commands are
approved. The choice is stored in `$HARNESS_STATE_DIR/config/configure-choices.json`;
a later `configure.py --replace` without the flag keeps it. New installs default to
`allowlist`.

| Policy | Generated global shell rules |
|---|---|
| `allowlist` (default) | Global `* ask`, then allows for exactly `pwd`, `git status*`, `git diff*`, `git log*`, `npm test*`, `npm run test*`, `pytest*`, `python3 -m pytest*`, `go test*`, `gofmt *`. Anything else asks. |
| `permissive` | `shell *` allow, followed by the `DANGEROUS_SHELL_ASK` ask list in `configure.py`: recursive `rm`, `sudo`/`doas`/`su`, force/delete/mirror/prune `git push` (`--force*`, `-f`, `+refspec`, `:ref`, `--delete`/`-d`, `--mirror`, `--prune`; plain `git push`, `-u`, `origin <branch>` are allowed, and `plugins/v2/shell-guard.mjs` also asks for forms wildcards miss: `-uf`, quoted refspecs, `git -C d push -f`, `-c alias.*`/`remote.*.push`, `git config alias.*`, `GIT_CONFIG_*` env, and any wrapper or compound), `git reset --hard`, `git clean -f`, `git checkout -- …`/`.`/`-f`, `git restore`, `git rebase`, `git add`/`git stage`/`git commit` on main/master (branch-gated, see below), `git commit --amend`, `git stash`, `git branch -d`/`-D`/`--delete`, `--force`/`-f`, `filter-branch`, `update-ref -d`, `chmod`/`chown -R`, bare or flagged `sh`/`bash`/`zsh`/`dash` (pipe-to-shell, `-c`), `eval`, `xargs … rm`, `find -delete`, `dd`, `mkfs`, `shred`, `kill`/`pkill`/`killall`, and secret-looking paths (`*.env*`, `*auth.json*`, `*.pem*`, `*.key*`, `*credentials*`, `*secret*`, `*financial-policy*`, `*external-write-grants*`). Env templates (`.env.example`, `.env.sample`, `.env.template` as a whole word, any directory) are allowed after the secret asks and before the command asks, so `rm -rf .env.example` still asks. |

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
  path (see "Secret paths" below; `.env`, `.env.*`, `*.pem`, `*.key`, `auth.json`, secret dirs,
  `*financial-policy*`, `*external-write-grants*`). Env templates (`.env.example`,
  `.env.sample`, `.env.template`, case-insensitive basename) are not secret.
- a segment that the configured rules allow only through an env-template exception still
  matches an ask/deny rule, or names a secret-looking path, once its template words are
  removed (`cp .env.example .env`, `diff .env.example .env.local`)
- a command names a secret path that the native `SECRET_SHELL_ASK` wildcards miss
  (`cat ~/.ssh/id_rsa`) while the configured rules would allow it.
- a redirect has no command word (`> f`, `true; >> log`)

Secret paths are path-shaped tokens only (no `|`, `(`, `)`, `\`, `^`, quotes or spaces):
`.env`/`.env.*` (not templates), `*.pem`, `*.key` (final extension), `auth.json`, `credentials`,
`id_rsa`/`id_dsa`/`id_ecdsa`/`id_ed25519`, dotted names containing `secret`/`credentials`
(`client_secret.json`), anything under a `secret*`/`credentials*` directory, and non-public files
under `.ssh/`. A token counts when it is a file argument (also `--opt=value`, `VAR=value`,
`host:path`), not when it is a grep/rg/ag/ack/`git grep` pattern or `-e` value, a sed/awk script,
or an `ssh`/`scp`/`sftp -i` identity. Quoted literals in code words and heredoc bodies are checked
(`python3 -c "open('.env')"`). Bare words such as `MY_SECRET`, `token` or `secret|key|pass` never
count. In every project, a native shell ask raised only by a `SECRET_SHELL_ASK` wildcard is
dropped by the evaluate hook when the guard's check of the call and of that resource finds no
secret path; any other ask on the same resource stands.
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

## Branch-gated git add/commit (permissive)

Agents may `git add`, `git stage` and `git commit` without a prompt when the repository's
current branch is not `main` or `master`. Static wildcards cannot see the branch, so this
is split between `configure.py` and `shell-guard.mjs`, and it fails closed:

- `configure.py` keeps a native ask for `BRANCH_GATED_ASK` (`git add*`, `git stage*`,
  `git commit*`). Without the guard every add/commit asks, as before.
- Before the shell runs, the guard resolves where each add/commit runs: the session
  directory (`ctx.location.directory`) plus the tool's `workdir`, then `cd dir &&` prefixes
  and `git -C dir` options. It reads the branch there with `git symbolic-ref -q HEAD`
  (2 s timeout; the full `refs/heads/…` ref, so a tag named `main` cannot confuse it).
- If every add/commit in the call targets a non-main/master branch, the guard records the
  call (session + tool-call id, single use, 120 s). Its `evaluate` hook then downgrades the
  native ask to allow, but only when each requested resource is allowed by the agent's rules
  or asks solely because of a gated pattern (re-evaluated without the gated patterns, so
  `git add .env` still hits the secret ask), and there are no more gated resources than
  verified segments.
- `main`/`master` (case-insensitive), a detached HEAD, a missing directory, a non-repository,
  a git error or a timeout keep the ask. Forms the static rules allow (`git -C repo commit`,
  `timeout 5 git -C repo add`) get a guard ask instead.

Anything that could change the branch, repository or directory makes the guard give up, so the
ask stands, even on a feature branch:

- the same command also runs `git checkout`/`switch`/`symbolic-ref`/`worktree`/`bisect`/`init`/
  `clone`/`rebase`/`update-ref`, `git branch -m/-M/-c/-C/-f`, a `git config` write, or
  `gh pr checkout`/`clone` (anywhere in the command, before or after the commit);
- `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE` or any other `GIT_*` variable except
  identity/editor/prompt/trace ones; `CDPATH`; a word or redirect touching `.git/…`;
- `git --git-dir/--work-tree/--namespace/--bare/…` or `-c` other than identity, signing
  and output keys (`user.*`, `author.*`, `committer.*`, `commit.gpgsign`, `core.quotepath`,
  `color.*`, ...); `-c alias.*` already asks via the push check;
- a `cd` that is not a plain top-level `cd <literal path>` in the same `&&` chain as the
  commit, starting the list or after `;`/newline: `cd x; git commit`, `false || cd x &&`,
  `(cd x && …)`, `cd x | …`, `cd $VAR`, `cd -`, `pushd`, `popd`, `builtin cd`, functions,
  `if cd …`, `source`/`.`/`eval`/`exec`;
- git behind anything other than a same-directory wrapper (`env` without `-C`/`-S`, `timeout`,
  `nice`, `nohup`, `command`, `time`, `stdbuf`, `setsid`, `xargs`), e.g. `env -C dir`,
  `find -execdir`, `echo git commit`, or `git-commit` run directly.

Always asking, on any branch: `git commit --amend` (and abbreviations such as `--amen`;
static `git commit *--am*`), wrapped add/commit (`timeout 60 git commit`, static
`WRAPPED_COMMAND_ASK`), `git branch -d/-D/--delete` (and `--del`, `-dr`), force/delete
pushes (the guard also catches long-option abbreviations like `--del`, `--mirr`), and every
other configured ask. The guard also re-evaluates `git -C dir <sub> …` and wrapped git
invocations in their canonical `git <sub> …` form, so `git -C x reset --hard` or
`git -C x stash` ask like their plain forms.

Known gaps: user- or system-level git aliases for commit (`git ci`) are not recognized as
commits (they were not asked before either); `git merge`, `pull`, `cherry-pick`, `revert` and
`am` create commits and are allowed as before; session-level permission rules are not visible
to the guard, so a session-only ask for a gated pattern can be downgraded on a feature branch.

## Per-project full-auto profile

`configure.py --full-auto-project DIR` (repeatable, persisted as `full_auto_projects` in
`config/configure-choices.json`; `--no-full-auto-project DIR` removes one) enables a near
full-auto profile for sessions whose location is inside `DIR`. Entries may list extra absolute
`data_dirs`. The generated profile is unchanged: `plugins/v2/full-auto.mjs` reads the list at
runtime (cached by mtime, so edits apply without a restart once the plugin is loaded).

Inside such a project the shell guard's `evaluate` hook turns asks into allows:

- `shell`: only for a call the guard inspected in `execute.before` (session + tool-call id) and
  found free of the forms below; each parsed resource is re-checked (secret patterns, pushes,
  history rewrites, disks). No inspection, no downgrade. The main/master branch gate does not apply.
- `external_directory`, `read`, `edit`: when every resource resolves (lexically and through
  symlinks) inside the project or a data dir.

Deny rules (secret read/edit denials, read-only roles' `shell`/`edit` denies) are never changed.
Reevaluation probes are not downgraded, so asks already pending stay for a human.

Still asking in a full-auto project (`fullAutoShellCheck`, applied to every segment, wrapped
command, `$(...)`, `sh/bash -c` and `eval` body, heredoc or here-string fed to a shell or `ssh`,
and `ssh` remote command):

- force/delete/mirror/prune pushes (all `gitPushDanger` forms), `git branch -d/-D`, `git tag -d`;
- history rewrites: `rebase`, `commit --amend`, `filter-branch`, `filter-repo`, `reset --hard`,
  `reflog expire|delete`, `gc --prune*`, `git prune`, `git replace`, `update-ref -d`;
  `commit --amend` is the one exception (approved: "auto-approve amends of unpushed commits on
  feature branches"): it is allowed when every amend in the command is a top-level `git commit`
  (plain, `git -C dir`, `cd dir &&` or a same-directory wrapper such as `timeout 60`) in a repo
  inside the project whose current branch is not main/master and whose HEAD is on no
  remote-tracking branch (`git branch -r --contains HEAD` empty; errors and timeouts count as
  pushed). Amends of pushed commits, on main/master or a detached HEAD, in `sh -c`/`eval`/heredoc/
  `ssh` bodies, or with branch/repo changes in the same command (`checkout`, `GIT_DIR`,
  `--git-dir`, `git config`, ...) still ask, as do force pushes and every other rewrite;
- `rm`/`rmdir`/`unlink`, `find -delete|-exec rm`, `rsync --delete|--remove-source-files` and
  truncating redirects (`>`, `>|`, `&>`) whose target is not strictly inside the project or a data
  dir (`/tmp` included for deletes), is the project root, `*` at the root or `.git`, is non-literal
  (`$VAR`, braces), comes from `xargs`, or uses `--no-preserve-root`. Remote (`ssh`) deletes ask
  for `/`, a top-level directory or the remote home (and globs over them). `docker rm`,
  `compose rm`, `git rm` and similar are not file deletes;
- `dd`, `mkfs*`, `mkswap`, `shred`, `wipefs`, partitioners, `/dev` block devices;
- secret-looking paths (file arguments, redirects and quoted literals in code/heredocs, as
  below; the native `SECRET_SHELL_ASK` wildcards are re-checked with the same argument-aware
  test, so `d.keys()` or `grep -viE "secret|key"` do not ask). One
  exception: the value of docker's env-file option (`--env-file FILE` or `--env-file=FILE` after
  a `docker`/`docker-compose` word, e.g. `docker compose --env-file ../.env up -d`, also behind
  `sudo`, in `sh -c` bodies and `ssh` remote commands) is not checked, because docker loads it
  into the containers' environment. Every other word still is: `docker compose --env-file .env up
  && cat .env`, `docker cp secrets.pem c:/x` and `cat .env` still ask, and `--env-file` on other
  commands is checked as before. `docker` must be the command word (first word, after a
  separator, `VAR=x` assignments, simple wrappers such as `sudo -E`/`timeout 600`, `ssh [opts]
  host` or `sh -c`), so `cat -- docker --env-file .env` still asks; `--` ends the exemption.
  Accepted residual risk (approved: passing an env file to docker is fine): docker itself can
  print the file's values, e.g. `docker compose --env-file .env config` or
  `docker run --env-file .env alpine env`;
  Second exception (0.3.2, the operator's standing rule: "always allow read-only access to
  /opt/wncscanner-docker/.env and the wncscanner-stack service"): exactly
  `/opt/wncscanner-docker/.env` is not checked when it is read with `cat`, `less`, `grep`, `stat`
  or `readlink` in the remote command of `ssh garage-server` (or `ssh user@garage-server`), e.g.
  `ssh -o BatchMode=yes -o ConnectTimeout=30 garage-server 'systemctl cat wncscanner-stack.service;
  cat /opt/wncscanner-docker/.env; docker ps'`. All of these must hold, otherwise it asks as before:
  ssh is the command word and runs from the local machine (not via `sh -c`, `eval` or another
  ssh), its only options are `-o BatchMode|ConnectTimeout|ServerAliveInterval|ServerAliveCountMax|
  ConnectionAttempts|LogLevel`, `-l user` and the flags `-4 -6 -C -n -q -T -t -v -x` (`-F`, `-J`,
  `-p`, `-i`, `-o HostName=...` ask); the read is a plain segment of the remote command (no `sudo`
  or other wrapper, not a heredoc body); both the local command and the remote command are one
  line, with no command or process substitution (`$(..)`, backticks, `<(..)`), no shell keywords
  or grouping (`{ }`, `if`, `while ... done`, `f()`) and no file redirect anywhere other than to
  `/dev/null` (so `exec > f; ...` asks); a pipe after the read or after the local ssh runs only
  `cat`, `less`, `grep`, `cut`, `head`, `tail` or `wc`; and `less` has no options or `+` commands. The path must match exactly (`/opt/wncscanner-docker/.env.prod`,
  `../` forms or another `.env` ask). Other secret-looking paths (as defined above; e.g.
  `/etc/shadow` is not one, as before) in the same command still ask, and so do
  `tee`, `sed -i`, `cp`, `mv`, `rm`, `chmod`, editors and redirects involving the file, `ssh
  other-host`, `scp`/`rsync` of it, and a local `cat /opt/wncscanner-docker/.env`. The exemption is
  full-auto only (the non-full-auto guard and `shellSecretReasons` are unchanged);
- the wncscanner-stack service (0.3.2, any host, local or over ssh): `systemctl` naming
  `wncscanner-stack`, `wncscanner-stack.service`, its unit file, or a glob/brace word containing
  `wncscanner` asks unless the verb is a read (`cat`, `status`, `show`, `is-active`,
  `is-enabled`, `is-failed`, `list-units`, `list-unit-files`, `list-dependencies`; option values
  such as `-n 50`, `-p ActiveState`, `-o cat` are skipped when finding the verb, and any change
  verb anywhere in the arguments asks); `service wncscanner-stack <verb>` asks unless the verb is
  `status`; and the unit file or drop-in (`wncscanner-stack.service`, with or without a
  directory, `.../wncscanner-stack.service.d/...`) asks unless the command is a reader (`cat`,
  `less`, `grep`, `stat`, `readlink`, `ls`, `head`, `tail`, `wc`, `sha256sum`, `md5sum`,
  `journalctl`) and it is not a redirect target. A unit named through a variable
  (`U=wncscanner-stack; systemctl restart $U`) is not caught (commands are judged lexically). Before 0.3.2 full-auto
  allowed `ssh garage-server 'systemctl restart wncscanner-stack'`; it now asks. Other units are
  unchanged;
- `curl … | bash` (a shell reading piped input), `ssh -o ProxyCommand|LocalCommand`;
- since 0.3.2, backticks inside a quoted word (`echo "`cat .env`"`) are scanned like `$(...)`
  (also inside single quotes, where nothing runs; that errs toward asking), and a line break after
  `|`, `|&`, `&&` or `||` keeps the operator (`curl x |` + newline + `bash` asks).

Known gaps: script files (`bash deploy.sh`, `python x.py`, `make`) and interpreters (`python -c`,
`node -e`) run unseen; remote paths are judged lexically; anything not listed above is allowed.

## 0.3.3: permission waits

Measured in r35: 67 of the 72 asks logged in r34 auto-allow under these rules; 5 still ask.

Full-auto now also allows:

- writes whose target uses a literal shell variable (`D=/repo/.review/x; cmd > $D/out`, `for i in 1 2; do cmd > out$i; done`) or an unknown variable after a literal in-project directory (`.review/verify-$TS/revision.txt`). Delete targets must still be literal or literally assigned;
- `cd T && cmd > rel` and `cd T && ( … > rel )`: segments joined to a top-level `cd` by `&&` run in `T` only. After `;`, a newline, `||` or `&`, the union of directories is used, as before;
- relative redirects that resolve into `/tmp`;
- secret-scan report files (`secret-scan.txt`, `secret-hits-lines.txt`): these are not secret paths anywhere. `secrets.txt`, `client_secret.json` and files under `secret*/` directories still are;
- `external_directory` asks from read-only tools (`read`, `glob`, `grep`, `list`, `large_file_check`, `structured_json_read`, …) for any path except credential paths (`~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.docker`, `~/.kube`, `gateway/secrets`, secret-looking names) and another project's files that are not tracked and clean. "Another project" means a sibling directory of the project that is a git repository. Cleanliness is checked with `git --no-optional-locks status --porcelain --untracked-files=all` and `git ls-files`, both read-only;
- `external_directory` asks from a shell call when the full-auto shell check of the command is clean and no word names another project's path. This covers OpenCode resolving `cd ../web` against the session root.

Full-auto now asks for:

- `sudo`, `doas`, `su`, `pkexec`, `run0` as a command (also behind `env`/`timeout`/`xargs` and over ssh);
- system service changes on any unit, local or over ssh: `systemctl` with a verb other than `cat/status/show/is-*/list-*` (or any change verb in its arguments), and `service <unit> <verb>` other than `status`;
- in projects with `no_push_deploy` (`configure.py --full-auto-no-deploy DIR`, removed with `--full-auto-allow-deploy DIR`): `git push` in any form, `gh pr create|merge`, `gh release create`, `gh repo create|sync`, `gh workflow run`, `docker|podman push`, `npm|pnpm|yarn publish`, deploy subcommands of `railway`, `fly`, `flyctl`, `vercel` (any use), `netlify`, `heroku`, `eas`, `firebase`, `wrangler`, `serverless`, `cdk`, `terraform`, `pulumi`, `kubectl`, `helm`, `gcloud`, `aws`, `az`, `doctl`, `twine`, and `scp`/`rsync` to a `host:` target. This is lexical: a deploy run from a script file is not seen.

The auto-permission `background_process` decline (non-full-auto projects) now means a real background job (`cmd &`, `nohup`, `setsid`, `disown`, `$!`); `&&` and `2>&1` no longer count.

Park and yield: the stall is logged on the first 10 s tick after an ask (a tick also runs immediately on each new ask), and a foreground parent waiting on the child is released after 30 s with a blocked result, so it continues other work. `HARNESS_PARK_NOTIFY_MS` and `HARNESS_PARK_AFTER_MS` still override this.

Still asking from the r34 log (by design): `git commit --amend` of a commit that cannot be verified as unpushed on a feature branch (1), `rm -rf` of a `/tmp/opencode` scratch directory, which is a delete outside the repo (2; adding `/tmp/opencode` as a `data_dirs` entry would allow it), and the garage-server `.env` read in a remote command that also has `$(...)` and a `for` loop, which the 0.3.2 exemption deliberately does not cover (2).

## 0.3.4: protected reads and source files named like secrets

From the r36 review. Under full-auto, read tools (`read`, `glob`, `grep`, `list`, …) and shell commands ask when they name a protected location, even read-only. The same check runs in the full-auto shell guard (path-like words, redirect targets and the working directory of every local segment, after literal variable expansion, inside `bash -c`/`eval` too) and in the auto-permission `external_directory` rule, so a command such as `sqlite3 …/Default/Cookies .dump` or `cat workrelay-bridge.json` asks once, from the guard. Protected:

- browser profile data: `Cookies`, `Extension Cookies`, `Safe Browsing Cookies`, `Login Data`, `Login Data For Account`, `Web Data`, `Local State` (with `-journal`, `-wal`, `-shm`) anywhere; `Default`, `Profile N`, `Guest Profile`, `System Profile` under a directory named like `chrom*`, `user-data` or `*-profile*`; anything below a directory that contains a `Local State` file;
- `/home/box/work/agent-profiles/**`, and every path under `/workspace/browser-probe` with a `*profile*` component;
- the harness install `/home/box/work/ocharness/**`, the state dir (`HARNESS_STATE_DIR`, and its parent when it is named `state`), `$OCH`, `$CLAUDE_CONFIG_DIR`, and directories listed in `HARNESS_PROTECTED_DIRS` (colon-separated).

Exceptions that stay readable: `<state>/check-receipts/**`, the harness code `<install>/harness/**` (the check runner `harness/releases/<v>/src/check_receipt.py`) and OpenCode's shell-output files `<install>/xdg/data/opencode/shell/**`. `grep` and `codesearch` on a directory that contains a protected location or `~/.ssh`/`~/.aws`/`~/.config`/`~/.gnupg` ask (`/home/box/work`, `/workspace`); `/workspace/browser-probe` itself stays searchable. Remote paths in `ssh` commands are not checked. Non-full-auto projects already ask for anything in the home directory outside the repo; protected locations are also credential paths there.

Source files named like secrets: a dotted, non-dot-file name containing `secret` or `credentials` whose extension is `.py`, `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.kt`, `.swift`, `.go`, `.rb` or `.java` is not a secret path (`credentials.py`, `AgentSearchCredentials.test.tsx`, `secret_utils.ts`). The permissive native rules allow `*credentials*.<ext>` and `*secret*.<ext>` (with or without trailing arguments) after `*credentials*`/`*secret*`, then repeat the other secret asks so `.env`, `.pem`, `.key`, `auth.json` still ask natively. Because native resources are whole commands, `cat credentials.json x.py` matches the allow; the shell guard asks for it, since a real secret path in a command the rules allow always re-asks.

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

## 0.4.0: auto-approve by default

Decision (Zach, 2026-11-22): bias to auto-approve. Every project uses the full-auto profile, whether or not it is listed in `full_auto_projects`. Pushes and deploys are allowed; `no_push_deploy` is ignored.

| Class | Decision |
|---|---|
| Force push, `--force-with-lease`, `--mirror`, `--delete`, `+refspec`; `filter-branch`, `filter-repo`; `rebase`; `reset --hard` to anything but `HEAD`; amend of a pushed commit | deny |
| Delete outside the project roots or `/tmp`; `dd of=/dev/…`, `mkfs`, `wipefs` | deny |
| Read, print, copy or send `.env*`, `*.pem`, `*.key`, token or `auth.json` files, 0.3.4 protected locations | deny (garage-server `.env` read-only exemption unchanged) |
| Everything else the guard or native rules used to ask for | allow |

Denials are immediate. The message names the rule and tells the agent to record a resumable blocker with the exact command and to continue other work without retrying variants. Native `ask` rules generated by `configure.py` become `allow`, except the deny classes above. As a safety net, `park-yield.mjs` auto-denies any ask still pending after `HARNESS_ASK_TIMEOUT_MS` (default 15 minutes) and records a resumable blocker.

Fixes in the same release: a top-level `cd T` to an existing directory inside the project keeps `T` as the working directory across `;` and newlines; the `read` tool may open a single `xdg/data/opencode/tool-output/tool_*` file; the native rule no longer asks again for a call the guard already decided.

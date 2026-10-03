# OpenCode Usage Harness

An experimental, subscription-aware OpenCode harness for task delegation, bounded file reads, quota pacing, and evidence-aware completion.

This is a source release extracted from a working private installation. It is **not a drop-in replacement for OpenCode or OpenChamber**. The offline installer and utilities are independently usable; agent integration targets OpenCode **2.0.18 with the supplied required-plugin patch**. Stock OpenCode, newer versions, Windows, and a fresh end-to-end public installation are not yet certified. See [compatibility](docs/COMPATIBILITY.md).

## Multiple subscriptions

The architecture separates provider/model routes from shared subscription allowances,
so independent pools can eventually run useful work in parallel without counting
one allowance twice. A provider-neutral offline planner is included; **live routing
still supports Codex only**. Claude and other subscription adapters, atomic runtime
reservations, and cross-provider dispatch remain integration work. See
[subscription-pool architecture](docs/SUBSCRIPTION-POOLS.md).

## What is included

- OpenAI ChatGPT OAuth policy checks, quota-window telemetry, and reset-relative pacing.
- Role-specific routing, revisioned task intent, scoped worker ownership, and resumption.
- Bounded reads (350 lines), targeted scout summaries, and one-use direct-read exceptions.
- Root-workload metrics that distinguish successful tools from complete tasks.
- An offline installer, versioned updates, integrity manifests, rollback, and fixture-based tests.

This is an independent project. It is not affiliated with OpenAI, OpenCode, or OpenChamber. Subscription capacity and eligibility are controlled by the provider. No benchmark-backed savings claim is made.

## Install the toolkit

Requirements: macOS or Linux, Python 3.10+, Git; Node 22.12+ to run plugin tests. No npm dependencies are needed for the offline tests. Inference additionally needs authenticated Codex CLI and a compatible OpenCode build.

Download the source for the release you intend to install from this repository's Releases page, or check out its version tag. Review it, then run from the repository directory:

```sh
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.mjs
python3 scripts/audit_public.py
python3 install.py install --source "$PWD"
```

Default installation: `~/.local/share/opencode-usage-harness`. The installer prints the installed version; it never edits shell startup files or starts a service. Add its bin directory yourself if desired:

```sh
export PATH="$HOME/.local/share/opencode-usage-harness/bin:$PATH"
harness-manage status
codex-quota --json
```

`codex-quota` reads the existing Codex CLI login through `codex app-server --stdio`; it does not make an inference call. It preserves the distinction between missing telemetry and exhausted quota. Use `HARNESS_CODEX_BIN` for an absolute executable path when Codex is not on PATH.

For metrics, explicitly identify the compatible OpenCode database:

```sh
export HARNESS_OPENCODE_DB="/absolute/path/to/opencode.db"
harness-metrics --days 7
harness-metrics --days 7 --json
```

The database is opened read-only. The public repository includes no database. Historical permission-blocked minutes are unknown, and artifact freshness is not independently verified by the metrics tool. Completed checks are self-reported evidence, not proof of real-world correctness. Tokens are not subscription-dollar prices.

## Enable agent integration separately

Read [COMPATIBILITY.md](docs/COMPATIBILITY.md) and [SETUP.md](docs/SETUP.md). The installer does **not** silently modify an existing OpenCode profile, choose account-specific model IDs, authenticate, buy credits, or install remote services.

The generated public profile asks approval for unknown shell commands, pushes, deployments, and destructive actions. Reasoned one-use large-file grants do not require a separate confirmation. Existing file permissions still apply. Your local preference for broader permissions can be configured explicitly.

## Update and roll back

Obtain and review the new release source in a separate checkout/directory. Run tests, then:

```sh
harness-manage update --source /absolute/path/to/new-release
harness-manage status
# If needed:
harness-manage rollback
```

Updates use the new source's `VERSION`; changed content cannot replace an already-installed version. Files are staged, hashed, and activated through an atomic `current` symlink. `previous` retains a rollback target. State, OAuth credentials, project files, and active services are not updated or restarted. Source manifests detect local corruption; **they are not cryptographic publisher signatures**. Obtain releases from a trusted repository and verify release checksums.

Agent profiles refer to the release from which they were generated. Updating toolkit code alone does not switch active plugin paths. At a planned idle point, back up state, regenerate/review the profile with the new release's `configure.py --replace`, and explicitly restart the compatible service. Rollback of code does not roll back profile or state: restore the corresponding profile backup too. Do not downgrade a database schema blindly.

## Configuration and state

| Setting | Meaning |
|---|---|
| `HARNESS_STATE_DIR` | Mutable state; default `~/.local/state/opencode-usage-harness` |
| `HARNESS_OPENCODE_DB` | Required explicit compatible OpenCode SQLite database |
| `HARNESS_CODEX_BIN` | Optional Codex CLI executable |
| `HARNESS_PYTHON` | Optional Python executable for plugin helpers |
| `CODEX_HOME` | Optional Codex configuration directory |

Release code and state are separate. Never commit auth files, financial attestations, telemetry, chat histories, or state backups. See [security and limitations](SECURITY.md), [contributing](CONTRIBUTING.md), and [changelog](CHANGELOG.md).

## Acknowledgments

The large-file context control was inspired by Spotify’s [“Portal by Spotify cut my Claude Code token usage by 90%”](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90) and the [Shunt plugin in spotify/portal-ai-plugins](https://github.com/spotify/portal-ai-plugins/tree/main/plugins/shunt).

Credit to Spotify for the approach of blocking broad reads of files over a 350-line threshold and delegating focused analysis to a smaller worker that returns a compact summary, while allowing targeted reads. This harness applies that approach to OpenCode with its own routing and quota controls. Spotify’s reported savings describe its experiments; they are not measured results for this project. No Spotify affiliation or endorsement is implied.

## License

MIT. The OpenCode compatibility patch retains upstream attribution in `NOTICE` and `compat/LICENSE.opencode`.

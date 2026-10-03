# OpenCode Usage Harness

**Put your coding subscription to work where it matters.** Give routine exploration
to a smaller model, reserve deeper reasoning for difficult problems, and pace work
against your actual quota resets—all from OpenCode.

OpenCode Usage Harness adds task routing, context controls, and usage visibility to
your coding workflow. The goal is more useful, verified work from the capacity you
already pay for. Stronger models and additional review belong where they improve
the result; unused quota alone is no reason to manufacture work.

**Start with [quota visibility](#install-the-toolkit), then
[enable the agent workflow](#enable-agent-integration-separately).** Interested in
combining several subscriptions? Explore the [pool planner and architecture](docs/SUBSCRIPTION-POOLS.md)
and [help build the next integrations](#contributing).

## What you get

| For your workflow | What the harness provides |
|---|---|
| Choose the right level of reasoning | Specialist roles for exploration, implementation, debugging, architecture, and review, mapped to models and efforts you select from your actual catalog. |
| See whether capacity is running out or going unused | Codex quota telemetry and pacing based on reported allowance windows and reset times. |
| Keep large files from crowding the main agent's context | A 350-line broad-read threshold, focused worker summaries, targeted reads, and reasoned one-use exceptions. |
| Keep delegated work connected to the task | Shared task intent, scoped worker ownership, resumption, and recorded acceptance evidence. |
| Understand what your agents accomplished | Workload metrics for usage, retries, tool results, and reported completion, with unknowns called out. |
| Keep subscription-only inference explicit | ChatGPT OAuth checks, account matching, financial admission checks, and no automatic API-key/provider fallback in the supported profile. |
| Adopt changes incrementally | An isolated toolkit installer, versioned updates, integrity checks, and code rollback. |

A typical workflow is: **check quota → scout the relevant code → delegate to an
appropriate specialist → run targeted verification → repair or escalate when the
evidence warrants it**. The full workflow requires the compatible agent integration;
installing the standalone tools does not activate it automatically.

## What works today

This is an **experimental project** extracted from a working private installation.
The standalone installer and utilities are independently usable. Live agent
integration currently supports **Codex through ChatGPT OAuth** and targets
**OpenCode 2.0.18 with the supplied required-plugin patch**.

A fresh end-to-end public installation, stock/newer OpenCode versions, and Windows
are not yet certified. OpenChamber installation and remote pairing are not included.
Read [compatibility](docs/COMPATIBILITY.md) before changing your agent setup.

The harness does not promise a percentage saving or a hard billing guarantee.
Provider-side subscription eligibility and spend controls still matter. See
[security and limitations](SECURITY.md). This project is independent of OpenAI,
OpenCode, OpenChamber, and Spotify.

## Multiple subscriptions

The longer-term goal is to put **Codex, Claude, and other eligible subscriptions to
work in parallel**, choosing tasks and model/effort combinations for each pool's
capabilities and remaining allowance.

The current development branch includes a provider-neutral **offline planner** for
independent pools, shared quota groups, per-window pacing, and concurrency slots.
It avoids treating two routes to one allowance as extra capacity. It does not
launch cross-provider agents. **Live routing remains Codex-only**; other adapters
must verify subscription access, quota identity, and financial controls first.

See the [architecture and runnable fixture example](docs/SUBSCRIPTION-POOLS.md).
This planning foundation is scheduled for 0.2.0 and is not in the v0.1.0 release.

## Remaining work and next steps

The next milestones are:

- **Make the first installation repeatable.** Validate a fresh public setup end to
  end, automate compatible runtime builds, and document verified platform coverage.
- **Connect the planner to safe parallel execution.** Add atomic reservations,
  crash recovery, task idempotency, and ownership checks before runtime dispatch
  across pools. Advisory slot counts alone are insufficient.
- **Add subscription adapters one at a time.** Verify supported authentication,
  model/effort discovery, quota telemetry, and no metered fallback for each provider.
  Claude and other subscriptions are candidates, not currently supported adapters.
- **Measure useful outcomes across pools.** Attribute task results, retries,
  elapsed time, and quota changes without equating token counts to subscription
  dollars. Evaluate independent-provider review where it adds value.
- **Improve distribution and remote setup.** Add signed releases, compatible
  binaries where practical, and documented OpenChamber setup and pairing.

**For users:** try the released quota tools first, check compatibility, and report
installation or workflow gaps with a sanitized reproduction. **For contributors:**
pick a bounded milestone above and propose how to validate it. The [changelog](CHANGELOG.md)
separates released functionality from development work; these milestones are not
promises of a release date.

## Contributing

Help make subscription-aware coding practical across more setups. Useful
contributions include first-install reports, regression tests, clearer onboarding,
provider adapter designs, and fixes for task routing or context handling.

1. [Open an issue](https://github.com/blankenshipz/opencode-usage-harness/issues) with
   the problem, expected behavior, and a small sanitized reproduction. Discuss new
   adapters or runtime changes before building a large integration.
2. Make a focused change with fixture-based tests. Keep credentials, account data,
   chat histories, and runtime state out of the repository.
3. Run the offline checks below and open a pull request explaining the behavior
   change, validation, and remaining limitations.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for test and release requirements and
[SECURITY.md](SECURITY.md) for the current safety boundaries. Automated tests should
not consume a real subscription or incur inference charges.

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

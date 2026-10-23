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

The standalone toolkit's `install`/`update` commands switch its tool release only;
they do not activate an OpenCode runtime. For a recovery runtime candidate, use
the separate [stage → provenance → activate procedure](docs/recovery-release.md).
Publishing or installing the toolkit does not make native runtime patches live.

| For your workflow | What the harness provides |
|---|---|
| Choose the right level of reasoning | Specialist roles for exploration, implementation, debugging, architecture, and review, mapped to models and efforts you select from your actual catalog. |
| See whether capacity is running out or going unused | Codex quota telemetry and pacing based on reported allowance windows and reset times. |
| Keep large files from crowding the main agent's context | A 350-line broad-read threshold, focused worker summaries, targeted reads, and reasoned one-use exceptions. |
| Keep delegated work connected to the task | Shared task intent, scoped worker ownership, resumption, and recorded acceptance evidence. |
| Understand what your agents accomplished | Workload metrics for usage, observed execution time, retries and reported acceptance, with overlap and unknowns called out. |
| Keep subscription-only inference explicit | ChatGPT OAuth checks, account matching, financial admission checks, and no automatic API-key/provider fallback in the supported profile. |
| Adopt changes incrementally | An isolated toolkit installer, versioned updates, integrity checks, and code rollback. |

A typical workflow is: **check quota → inspect only the relevant code → route to
an appropriate specialist → run targeted verification → repair or escalate when
the evidence warrants it**. A separate scout is useful when discovery is needed,
not a required extra agent for every task. The full workflow requires the compatible
agent integration; installing the standalone tools does not activate it automatically.

Recovery status distinguishes a running compaction, successful compaction awaiting
same-child continuation, and failed compaction awaiting recovery. Quota telemetry
failures keep admission closed and retain generation-bound parent notifications;
notification delivery never resumes inference. See the
[staged recovery release and activation procedure](docs/recovery-release.md) for
compatibility, artifact verification and live-install limitations.

## How model and reasoning selection work

The behavior below describes the current development branch and its compatible
V2 agent integration, not everything in the v0.1.0 toolkit release.

The public profile uses four user-supplied tiers: **FAST, BALANCED, STRONG and
MAXIMUM**. Each maps to an actual `openai/<model-id>#<variant>` reference discovered
in your account's catalog. The variant selects the reasoning effort supported by
that model. The harness does not assume particular model names, a universal effort
ladder, or that API prices describe subscription consumption.

The generated profile in [configure.py](configure.py) maps roles as follows:

| Agent | Configured tier | Intended work and capabilities |
|---|---|---|
| `router` | STRONG | Own the goal, choose workers, integrate evidence; no shell or edits. |
| `coordinator` | BALANCED | Coordinate multiple sustained lanes through terminal workers; no shell or edits. |
| `scout` | FAST | Focused repository exploration and summaries; no shell, edits or delegation. |
| `quick-builder` | FAST | Mechanical fixes, small localized changes and straightforward tests. |
| `builder` | BALANCED | Ordinary implementation and feature work. |
| `deep-debugger` | STRONG | Ambiguous failures and difficult debugging. |
| `architect` | STRONG | Design and consequential analysis; no shell or edits. |
| `reviewer` | STRONG | Correctness, regression and risk review; no shell or edits. |
| `maximum` | MAXIMUM | Exceptional problems where the expected quality improvement justifies the capacity. |

Only the router and coordinator delegate; other roles are terminal workers.
Shell-capable roles still obey native command permissions. Assign executable checks
to a capable worker rather than expecting a read-only reviewer to run them.

**Selection is task → role → configured model and effort.** The parent is instructed
to choose the smallest capable worker, accounting for complexity, risk, prior
verification and quota pressure. One bounded task normally goes directly from the
router to one worker. A coordinator or independent review is justified by the task,
not added automatically. Passing, sufficient verification is a reason to stop;
uncertainty alone is not a reason to escalate.

By default, every role sharing a tier also shares its configured reasoning variant.
There is no automatic low/medium/high effort optimizer or measured price ranking.
Customize role references explicitly when different efforts are appropriate. The
public generator selects STRONG for the router; it does not dynamically demote the
primary router. An existing private profile may have different role assignments.

Every admitted worker dispatch, including a continuation, passes the effective
model reference to OpenCode so an old child does not silently retain an obsolete
model. An explicit dispatch `model` override persists for that work key;
`resetModel: true` returns to configured selection. A UI model change observed
after a known harness selection is also preserved. Legacy children have no override
provenance: their next dispatch adopts the configured role unless an explicit
model is supplied. This does not change inference already running. Dispatch status
shows configured, selected and previously observed models; completed-response
telemetry is the evidence for what actually ran.

### Quota pacing and the automatic adjustment

`codex-quota` reads actual reported allowance windows through Codex's app-server.
For each usable window, it calculates elapsed fraction from its duration and reset
time, then `pace_delta = used_percent - elapsed_fraction × 100`. Missing windows
stay unknown; neither a weekly nor a short window is assumed to exist.

At meaningful dispatch boundaries, the parent supplies task complexity and risk.
The routing quota read is cached for 30 seconds, and telemetry older than two minutes
is unsuitable for selection. **If any usable window is more than ten percentage
points ahead of pace, or has at most 10% remaining**, an explicitly routine,
normal-risk `builder` or `deep-debugger` dispatch can use the configured
`quick-builder` model and variant within the same provider. This is a specific
role substitution, not a general one-rung search across all tiers. The worker keeps
its original role, permissions and ownership.

High-risk work, explicit overrides and other roles are not automatically demoted.
Absent routing classification or usable telemetry retains configured selection;
the independent financial guard still blocks inference when admission cannot be
established. Behind-pace capacity does not automatically promote a model, launch a
review or generate work. The parent may choose stronger reasoning or useful extra
verification when justified. The objective is useful prepaid capacity, not token
burn or a guaranteed 97–100% utilization target.

## Usage optimizations and their limits

These controls work together; some are automatic middleware, some are dispatch
rules, and others are instructions for the agent. None establishes a hard spending
ceiling or a promised percentage saving.

| Optimization | Behavior and limits |
|---|---|
| **Short instructions and focused handoffs** | Shared instruction sections are about 60% smaller than the preceding revision. Revisioned task intent carries the goal, authorization and checks; handoffs add bounded objectives, files and evidence. Agents are instructed to batch bookkeeping at meaningful transitions rather than repeat raw context. |
| **Large-file read control** | The guard blocks broad reads over the 350-line threshold while allowing targeted ranges. A focused smaller worker can return a summary; terminal workers cannot recursively delegate. An eligible writer can request a reasoned one-use direct-read exception. Agents are told not to page through a whole file to evade the guard; ordinary permissions still apply. |
| **Recoverable tool-result compression** | Automatic V2 middleware compacts eligible new JSON, rectangular arrays and plain search listings, collapses exact consecutive repetitions in recognized test/build logs, and shortens unchanged Git diff context. Every JSON row/value and every diff change remains represented. It adds no inference call. |
| **Exact originals on demand** | A profitable projection is published only after its exact original is stored privately. Retrieval uses bounded native reads under existing permissions. Source reads, edits, patches, unknown tools and nested CodeMode fallback text are not rewritten. Malformed, oversized or unprofitable results pass through. A snapshot is not proof of current file contents. |
| **Stable history and cache diagnostics** | Tool compression happens once on new results, without repeatedly rewriting history. Passive cache monitoring observes instruction/tool/early-message changes and reported cache-token counters. It does not alter cache headers, guarantee cache hits or perform inference. |
| **Selective conversation compaction** | High context produces an advisory. The parent can request native same-session compaction at an idle checkpoint with no active descendants, keeping ownership and refreshing intent afterward. Continuation waits for the matching durable outcome. This is opt-in, can consume included inference and does not clone the worker. |
| **Same-worker resumption** | Stable task/work keys and ownership reuse the existing child instead of launching replacements. Revision and assigned-check bindings help prevent stale scope from carrying forward. Explicitly marked historical copies point to the canonical chat and cannot start competing inference; old copies are not automatically discovered or merged. |
| **Bounded work and cumulative review** | A cooperative reminder after ten minutes or 30 prepared model steps asks for evidence and a next action; it does not cancel tools. At the next idle admission, 120 steps/six continuations per lane or 240 steps/12 continuations across the root task require an agent-supplied evidence-backed reassessment. Totals survive handoffs; this is not a new human approval gate. |
| **Repeated-work detection** | Two continuations without new reported progress produce a convergence advisory. Changed wording, timestamps or artifact churn alone do not count as progress. Evidence remains self-reported and must be checked; the advisory is not an automatic stop or extra review call. |
| **Verification reuse and retained diagnostics** | Instructions favor targeted checks, reuse of unaffected passing evidence and follow-up reviews of changed findings. Substantial checks retain stdout, stderr, exit status and revision in private receipts, with bounded previews and disk-space checks. Necessary tests still run; avoiding quota is not a reason to skip requested validation. |
| **Useful human/device attempts** | Optional verification records retain readiness, expected signal, result references and expiry so agents inspect prior evidence before asking for another live test. They do not verify a physical device themselves or turn expiry into an automatic retry. |
| **Background completion and health visibility** | Sustained implementation, coordination and deployment default to native background work; completion resumes the parent. Guidance discourages polling and duplicate workers. Read-only health/status tools help distinguish stale status from execution; they do not automatically retry or restart services. |

Compression only considers results from 4,096 characters up to 1 MiB and requires
at least 512 characters and 15% savings, including retrieval instructions. The
private original store is bounded; once full, new results pass through instead of
evicting evidence. These are character reductions, not measured subscription-token
savings. Provider-hosted tools and background completion results are not covered
by this local compression hook.

For operational details, see [routing, review thresholds and compaction](docs/USAGE-CONTROLS.md),
[compression and retrieval](docs/CONTEXT-COMPRESSION.md),
[diff previews](docs/DIFF-PREVIEWS.md), [compression diagnostics](docs/COMPRESSION-DIAGNOSTICS.md),
[cache monitoring](docs/CACHE-DRIFT.md), [convergence and live attempts](docs/CONVERGENCE.md),
and [execution, receipts and outcome telemetry](docs/TELEMETRY.md).

### Measure outcomes, not just smaller prompts

Use `harness-metrics` to compare completed work, reported acceptance, retries,
observed execution time, input/output/cache tokens, compression characters and
cache-drift observations. Compare those with actual quota deltas during ordinary
work. Account-wide allowance can also be consumed by other Codex clients, cached
tokens are not free by assumption, and model names do not establish cost. Retained
receipts and tests support acceptance; metric counts alone do not prove correctness
or savings.

The supported profile keeps OpenAI-only access, ChatGPT OAuth/account checks and
financial admission separate from optimization. Quota pressure never authorizes
purchased credits, API-key inference or an automatic paid/provider fallback.
Compression and context diagnostics are model-family-neutral middleware; that does
not mean other subscription providers are enabled or validated today.

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
OpenCode, OpenChamber, Spotify, or Headroom.

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
- **Validate usage improvements in ordinary work.** Compare accepted results, cumulative
  work, effective models, compaction outcomes and actual quota deltas. Model-step
  thresholds are reassessment points, not hard spending limits.
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

Preserve expensive check output privately with `harness-check --label tests --revision REV -- python3 -m pytest`. Each run keeps separate stdout, stderr and an exit-status receipt. Optional `harness-check --preview RECEIPT --stream stderr` returns a bounded page with exact repeated lines compacted; see [durable diagnostics](docs/TELEMETRY.md#release-gates-and-durable-diagnostics).

Progress guidance separates active execution from verified outcomes. When small work expands, agents revisit the next useful result; follow-up reviews carry existing findings forward and focus on affected changes. Checkpoint reminders are injected on existing primary model requests; they are cooperative guidance, not hard timeouts, new approval gates, or timer-driven model calls.

The database is opened read-only. The public repository includes no database. Historical permission-blocked minutes are unknown, and artifact freshness is not independently verified by the metrics tool. Completed checks are self-reported evidence, not proof of real-world correctness. Tokens are not subscription-dollar prices. For deduplicated completion counts and token totals across legacy logs and the new ledger, see [completion telemetry](docs/TELEMETRY.md).

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

Headroom inspired our recoverable tool-result compression: the V2 harness now automatically compacts eligible new JSON, search listings, and repeated test/build output before they enter model context. Conservative [diff previews](docs/DIFF-PREVIEWS.md) retain all changes while shortening unchanged context; [diagnostics](docs/COMPRESSION-DIAGNOSTICS.md) explain skipped results, and [passive cache monitoring](docs/CACHE-DRIFT.md) detects prepared-context changes without rewriting requests. Every JSON row/value remains represented; exact originals are retained privately and can be read in bounded chunks through OpenCode's normal read tool. Nested CodeMode values, source reads, errors, permissions, and existing conversation history stay intact. No extra inference or proxy is required. We independently implemented these ideas after examining Headroom's [log compressor](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/crates/headroom-core/src/transforms/log_compressor.rs) and [compression store](https://github.com/headroomlabs-ai/headroom/blob/976aa714ef3e19174dc0cb586cee7b20d064e4ef/headroom/cache/compression_store.py). See [automatic compression and retrieval](docs/CONTEXT-COMPRESSION.md), including limits and the local snapshot security boundary. Existing [bounded check-log previews](docs/TELEMETRY.md#bounded-log-previews) remain available.


## License

MIT. The OpenCode compatibility patch retains upstream attribution in `NOTICE` and `compat/LICENSE.opencode`.

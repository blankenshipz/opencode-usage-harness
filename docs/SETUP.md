# Isolated agent profile

Do not run this against an existing production profile without reviewing the differences. First provision the compatible runtime described in COMPATIBILITY.md. Keep your current service intact until the new setup is validated.

1. Configure only the subscriptions you intend to use. For OpenAI, authenticate Codex CLI and OpenCode to the same ChatGPT account using browser/device OAuth. For Claude, install the reviewed [Claude OAuth adapter](CLAUDE-SUBSCRIPTION.md) and connect the subscription; Claude-only users do not need Codex CLI or an OpenAI account. For both pools, complete both paths. Never select API-key authentication.
2. Discover your actual enabled-provider model IDs and reasoning variants from the runtime's catalog. Create a local JSON mapping with exactly `FAST`, `BALANCED`, `STRONG`, and `MAXIMUM`; each value must be an actual `openai/model#variant` or `anthropic/model#variant` reference. The generator checks syntax, not subscription availability.
3. Prepare the separate harness profile from the installed release:

```sh
export HARNESS_STATE_DIR="$HOME/.local/state/opencode-usage-harness"
python3 "$HOME/.local/share/opencode-usage-harness/current/configure.py" \
  --models /absolute/path/to/your-models.json
```

The generator refuses to replace an existing profile unless `--replace` is supplied; replacement creates a timestamped backup. It creates an OpenAI financial-verification file with **unverified defaults** only when OpenAI is enabled. It never marks controls verified automatically. Providers come from the four tier references and any explicitly enabled routing candidates. Without `--routing-policy`, any old managed policy is backed up and removed, including an orphaned policy left without a profile. Credentials are preserved.

4. **OpenAI enabled:** in your account UI verify no purchased credit balance, disabled automatic top-up, and disabled automatic reload. Only then update the local `config/financial-verification.json` fields: `auto_top_up_off`, `automatic_reload_off`, `purchased_credit_balance_ui`, and an ISO timestamp `verified_at`. Never put this attestation in the public repository. A stored attestation can go stale; changes to account billing settings require re-verification.
   **Claude enabled:** disable usage credits in Claude Settings → Usage. The guard checks the selected Claude OAuth account directly; it does not require the OpenAI attestation file. Catalog visibility alone is not authentication.

5. Set `HARNESS_OPENCODE_DB` to the actual database used by your isolated compatible runtime. Dispatch requires the V2 `session_v2` and `session_message` schema. Do not guess a path or point at another profile's database.
6. Start the compatible executable using a controlled environment. Preserve HOME, your reviewed PATH, CODEX_HOME if used, and the harness path settings. Explicitly remove API-key/base-URL overrides. Set `OPENCODE_CONFIG_DIR` to `$HARNESS_STATE_DIR/config` and `OPENCODE_REQUIRED_PLUGINS` to `subscription.guard,subscription.large-file-context,subscription.task-outcomes`.

Use separate XDG data/config/state/cache directories when running an isolated test service. Review project-level configuration too. The toolkit provides guard checks, not an operating-system sandbox, and does not disable arbitrary user-installed plugins.

The generated roles use your selected tier/variant references. Tune effort using real catalog variants; the generator does not infer a universal low/medium/high model hierarchy. Read-only roles cannot edit or execute shell commands. Router/coordinator can delegate; leaf workers cannot. Routine formatting/tests have selected allow rules while unfamiliar or consequential shell commands require approval.

Model request admission applies provider-specific checks: OpenAI OAuth/account matching, local financial attestation and actual quota admission; Claude subscription OAuth and disabled usage credits. Both restrict provider endpoints and reject API-key fallback. Account controls remain the ultimate authority: this software cannot guarantee a subscription service will never charge credits. Do not use it to evade provider quotas or access restrictions.

### Preserve GitHub CLI login in isolated launchers

Before changing `XDG_CONFIG_HOME`, call
`src.launcher_environment.github_cli_environment(home=..., original_env=...)`
and merge its returned `GH_CONFIG_DIR` into the controlled environment. It
preserves an explicit GitHub config directory, otherwise the original XDG config
location or the user's normal `.config/gh`. It never reads or copies credential
files and never forwards `GH_TOKEN`, `GITHUB_TOKEN` or inference API keys.
Check `gh auth status` in the resulting runtime environment. This is authentication
visibility, not authorization to create repositories, commit, push or publish.

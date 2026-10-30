# Optional Claude subscription connection

Claude can be the only subscription pool or an additional pool beside Codex.
For Claude-only configuration, map FAST/BALANCED/STRONG/MAXIMUM to discovered
`anthropic/model#variant` references. The generator enables only Anthropic;
Codex CLI, an OpenAI login and OpenAI financial verification are not required.
The Claude OAuth adapter below must still be installed and configured separately.
An optional enabled routing policy adds only its enabled candidate providers.

This path uses the third-party griffinmartin/opencode-claude-auth plugin 3.0.0,
with its Claude Code subscription OAuth method. Anthropic prohibits third-party
subscription credential reuse; installing this adapter does not change eligibility
or guarantee continued service. See the current OpenCode provider documentation:
https://opencode.ai/docs/providers/#anthropic

## Authentication and financial admission

Install the official Claude Code for the host architecture, and sign in with
`claude auth login --claudeai`. Import it through OpenCode's Anthropic integration
using **Import Claude Code subscription**. Never select the API-key method.
The adapter checks the active connection is OAuth, its method ID is `claude-code`,
and its metadata identifies the reviewed plugin. API-key credentials, custom
provider packages, custom endpoints, and Anthropic credential environment overrides
are rejected. The service must run with its clean managed environment.

Before inference the guard queries Anthropic's native OAuth usage endpoint using
the same selected access token. It requires `extra_usage.is_enabled` to be exactly
false. Missing data, an enabled value, failed authentication, timeout or network
failure blocks inference. Successful proof is cached briefly in memory. This is
an internal account endpoint, not a guaranteed public API; a schema change fails
closed and may require an adapter update. The provider's included-usage limits
remain the final hard stop. This admission check is separate from the advisory
quota normalizer and opt-in candidate router, which expose account and model-scoped
pacing when usable window data is present. Missing recognized session/weekly
durations are inferred and labeled; they are not reported provider guarantees.

Max's monthly API credits are separate from subscription usage credits. Neither
an API credit balance nor permission to consume it is implied by this connection.
Only the subscription OAuth path is admitted. OpenAI keeps its own existing
account-matching, financial-verification and Codex quota checks; exhausted Codex
allowance does not block a separately admitted Claude request.

## Managed plugin artifact

Pin an exact built plugin and dependencies; a Git checkout alone lacks its dist
output. Verify the directory entrypoint in an isolated matching OpenCode runtime.
Native OpenCode 2 configured plugin paths must be directories. Do not blindly
install a moving latest tag into a running custom release.

Apply the companion hash-pinned managed patch before enabling this plugin in a
subscription-only harness. It removes hidden Claude CLI generation during token
refresh, automatic borrowing of another account, and response retries that run
outside the harness's admission hooks. Ordinary OAuth refresh for the selected
account remains. Failed inference responses are returned to the caller for explicit
recovery. Preserve the package license and original commit provenance.

Back up config, artifacts and release manifest; include the managed entrypoint
and its complete payload receipt in startup integrity verification. At idle, load
the adapter and verify the guard and authentication plugin are active, the provider
effective model catalog contains only the providers you enabled (Anthropic alone
or Anthropic and OpenAI), and the actual models are discoverable.
Keep existing sessions, project permissions and default agents unchanged.

Validation uses fake credentials and fake account/provider responses for negative
cases. A small authorized live subscription request can then confirm the selected
model works; do not exhaust quota or buy credits to test a boundary.

## Explicit opt-in configuration

Preserve existing policies and agent definitions. For a two-pool native V2
profile, set `enabled_providers` to `["openai", "anthropic"]` and retain
deny-by-default rules. For Claude only, use `["anthropic"]` and omit the OpenAI
allow rule:

```json
{
  "experimental": {
    "policies": [
      { "effect": "deny", "action": "provider.use", "resource": "*" },
      { "effect": "allow", "action": "provider.use", "resource": "openai" },
      { "effect": "allow", "action": "provider.use", "resource": "anthropic" }
    ]
  }
}
```

Install both the updated guard helper and the patched authentication artifact.
Discover model IDs and variants from the running catalog; do not infer subscription
entitlement from a catalog entry alone. The provider registry may contain a built-in
OpenCode entry even when policy excludes its models. Verify the effective model
catalog and request admission, not registry names alone.

The managed integration was verified on custom OpenCode 2.0.30 with a completed
Claude Haiku 5.5 / low subscription response. Catalog visibility is not a claim
that every listed model has been exercised. The patched artifact keeps Haiku 5.5
effort enabled; its legacy Haiku 4.5 compatibility path strips effort because
that model family does not support it. The standalone `subscription-quota.mjs`
command reports Claude as `unknown [adapter_unavailable]` because it has no
OpenCode session context and therefore cannot read the selected OAuth token.
Inside a running managed session, the `subscription_quota` tool reads the
currently selected Claude OAuth usage endpoint and reports the independent
Anthropic windows and scoped Fable limit when present.

The routing policy is separately opt-in. It does not add Claude candidates to
an OpenAI-only profile, and it does not retry a failed Claude request
through another provider. See [native and multi-pool routing](NATIVE-AND-MULTI-POOL.md)
for candidate, continuation and review behavior.


## Shared telemetry and bounded recovery

Claude routing and inference admission use the same private telemetry cache. A
successful snapshot stays fresh for 60 seconds. Concurrent lookups for the same
selected OAuth credential coalesce across processes, including after restart.
Cache keys are opaque digests; credentials and raw provider errors must never be
stored in cache records. Credential rotation starts a new verification boundary.

A timeout, network failure, HTTP 429 or server failure is not quota exhaustion.
After a transient failure the last verified snapshot may support inference only
while its original disabled-usage-credits evidence is less than 24 hours old.
Cache reads and failed lookups never extend that deadline. Routing preserves the
original timestamp and exposes stale/cooldown metadata. Recovery snapshots are
unknown for quota pacing, even within the ordinary advisory freshness limit.
Cached HTTP failures retain their sanitized numeric status; legacy records with
no status remain unknown, and later non-HTTP failures clear the prior status.

Failed lookups enter a cooldown. Numeric and HTTP-date Retry-After hints are
retained with a one-day safety bound; absent or zero hints use
backoff starting at 60 seconds and doubling up to ten minutes. A lookup makes one
network attempt, with no internal retry loop. Cooldown expiry permits a later
caller to check again; it does not automatically resume a worker or make an
inference call.

Authentication failures, invalid financial responses, enabled usage credits,
confirmed applicable exhaustion, and expired financial verification remain
blocking. A new unsafe response invalidates prior safe evidence. Switching model
families must not treat a reported account-wide limit as a separate quota pool.
No API-key fallback, account substitution, credit purchase or inference retry is
introduced. The selected OAuth connection and endpoint checks still run for each
request.

The 24-hour interval is a bounded trust window, not a provider-side billing
lock: an account setting changed during it may not be observed immediately. Keep
usage credits disabled in the account UI. Codex keeps its independent account,
credit and quota checks; this Claude recovery policy does not relax them.

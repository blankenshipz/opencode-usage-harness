# Short-window pacing

`subscription_quota` includes an advisory `advisory.short_window_pacing` object for each provider pool. It observes reported percentage use in short, account-scoped windows, such as a five-hour session window. It does not query a provider beyond the normal quota read, trigger polling, admit or deny work, allocate capacity, estimate tokens, or infer credits or cost.

The advisor records a bounded local history only when the quota reader can supply a private identity for the currently selected credential. That identity is used only as a hashed local namespace. It is not included in tool output, filenames, or persisted payloads. If no safe identity is available, the result is `unknown` with `account_identity_unavailable`; it never combines samples from separate accounts. Credential rotation similarly starts a new history and remains unknown until enough new samples exist.

The Claude selected-OAuth reader supplies this private sidechannel. The current Codex quota reader does not, so Codex short-window pacing remains unknown until it can provide an equivalent local identity without widening credential access.

Each history entry is tied to a provider, selected credential identity, and exact reset window. A reset time change starts a new series. Missing, stale, malformed, or decreasing counters do not produce an estimate. The local state holds at most 32 account namespaces, eight windows per namespace, and three recent samples per window. State files use owner-only permissions and an inter-process lock.

An estimate needs two fresh samples at least one minute apart with an increasing reported percentage. When present, the window reports rounded observed duration, percentage change, hourly percentage rate, and an approximate exhaustion time only if it occurs before the current reset. An estimate that falls after reset is expressed as `reset_before_estimated_exhaustion` rather than a misleading date.

Consumers may use this as one signal when choosing among already eligible included subscription pools or when moderating optional fanout. It is not authority for a paid fallback, an admission gate, account selection, or a claim of remaining token capacity.

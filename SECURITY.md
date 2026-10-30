# Security and financial boundaries

This is experimental code, not a sandbox or a guarantee against charges. The large-file guard recognizes common read paths; arbitrary programs can read files. Permission policies, operating-system access, and provider billing controls remain important.

Never post credentials, auth databases, chat transcripts, private host addresses, or financial verification files in issues. Report sensitive findings through a private maintainer contact or GitHub private vulnerability reporting when enabled. No private reporting channel is claimed until repository publication/configuration is complete.

The default generated profile asks before unknown shell operations. Unrestricted local configurations are not the public default. A plugin can execute local code with the user's privileges; review release sources before installation.

Integrity manifests detect changed installed files. They do not authenticate a publisher or prevent a malicious owner from changing both source and manifest. The installer does not download or execute remote install scripts. Runtime patch compatibility must be verified separately.

Account attestations are user-supplied, can become stale, and are not an independent billing lock. No provider fallback, purchased-credit use, credit purchases, or auto-top-up configuration is implemented here.

Claude telemetry recovery reuses verified disabled-overage evidence for less than 24 hours from its original successful read. The timestamp never advances on cache hits or failed lookups. Quota telemetry itself is fresh for only 60 seconds and stale quota is not routing evidence. It does not observe account-setting changes instantaneously, so keep usage credits disabled; this bounded recovery is not an account-side billing lock. Unsafe/authentication responses invalidate prior evidence, and expired financial verification cannot authorize inference.

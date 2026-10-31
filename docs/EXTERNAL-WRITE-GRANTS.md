# External write grants

`task_dispatch` normally accepts only workspace paths. An operator may authorize
one existing implementation child to write below a separate directory by placing
an owner-only `0600` regular JSON file at:

`$HARNESS_STATE_DIR/config/external-write-grants.json`

The file and its config-path components must not be symlinks. It contains a
versioned list of exact, canonical bindings. This synthetic example shows every
required field:

```json
{
  "version": 1,
  "grants": [{
    "version": 1,
    "grantID": "migration-grant-20261031",
    "workspace": "/Users/example/Code/source",
    "rootID": "ses_root",
    "parentID": "ses_root",
    "childID": "ses_existing_builder",
    "taskId": "migration",
    "workKey": "copy-live-skill",
    "intentRevision": 4,
    "checkIds": ["copy", "verify"],
    "agent": "builder",
    "operation": "implement",
    "externalRoot": "/Users/example/Code/live-skills",
    "expiresAt": "2026-11-01T00:00:00.000Z",
    "revoked": false
  }]
}
```

Use the exact existing child ID and canonical absolute paths. A new child cannot
use a grant. Dispatch supplies `externalWriteGrantID` and an explicit absolute
`writePaths` destination on the first external admission. Continuing that same
child may omit `writePaths`; the dispatcher re-reads the grant on every
admission, so revocation, expiry, changed bindings, symlinks, or destinations
outside `externalRoot` stop the continuation before native dispatch.

Grant records are operator evidence, not a new tool or agent-editable state.
Generated agent policy denies editing the grant file. Native permissions still
apply. This coordinates dispatcher admissions and does not claim syscall-level
filesystem confinement or relocate native session directories.

Global path leases serialize harness-managed writer admissions across workspaces.
External admission also rejects overlapping active destination sessions, including
sessions created before this feature. Native Build/Plan, direct tools and other
processes do not participate in these leases: the operator must keep the destination
quiescent throughout migration. This is not a filesystem lock against arbitrary
clients. Expiry/revocation is checked at admission, not mid-execution.

A proven native permission denial before a child exists releases its provisional
lease. Ambiguous childless failures retain it for exact operator reconciliation;
restarting the process alone is not proof that no work began.

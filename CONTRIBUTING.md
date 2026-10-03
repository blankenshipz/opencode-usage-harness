# Contributing

Use Python 3.10+ and Node 22.12+. Run the offline Python and Node tests plus `python3 scripts/audit_public.py`. Tests must use fixtures and temporary state, never a real account or model call. Add regression coverage for ownership, permission, financial-admission, and updater changes.

Keep runtime state and credentials outside this checkout. Supply a minimal synthetic reproduction for bugs. Preserve upstream attribution for borrowed code. Include actual platform/runtime validation evidence; do not claim production or cross-platform support from mocked tests alone.

For a release: bump VERSION and package.json together, update CHANGELOG.md, run tests and the source hygiene scan, review the entire staged diff, and publish a version tag and checksum-bearing source archive. Do not overwrite an existing release tag. Verify installation and rollback from a clean prefix. A changed runtime patch requires fresh negative enforcement tests and build verification before advertising compatibility.

After reviewing and committing a release, create the tag and package its exact tree:

```sh
git tag -a v0.1.0 -m 'Experimental 0.1.0 source release'
python3 scripts/release.py --tag v0.1.0 --output-dir ../harness-release-0.1.0
```

The packager refuses dirty trees, mismatched versions, non-HEAD tags, or overwriting existing artifacts. It does not upload anything. Publish the tag, source archive and `SHA256SUMS` through the repository's release page after CI passes. Release checksums provide integrity, not a signed provenance guarantee.

#!/usr/bin/env bash
# Usage: install-git-hooks.sh [--force] <repo>
# Installs scripts/git-hooks/pre-push into <repo>. Refuses on a dirty tree unless
# --force; never overwrites a different existing pre-push hook.
set -euo pipefail
force=0
repo=""
for arg in "$@"; do
  case "$arg" in --force) force=1 ;; *) repo="$arg" ;; esac
done
[ -n "$repo" ] || { echo "usage: $0 [--force] <repo>" >&2; exit 2; }
src="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/git-hooks/pre-push"
git -C "$repo" rev-parse --git-dir >/dev/null 2>&1 || { echo "install-git-hooks: $repo is not a git repository" >&2; exit 1; }
if [ "$force" -ne 1 ] && [ -n "$(git -C "$repo" status --porcelain)" ]; then
  echo "install-git-hooks: refusing, $repo has uncommitted changes (use --force)" >&2; exit 1
fi
hooks="$(git -C "$repo" rev-parse --git-path hooks)"
case "$hooks" in /*) ;; *) hooks="$repo/$hooks" ;; esac
dest="$hooks/pre-push"
if [ -e "$dest" ]; then
  if cmp -s "$src" "$dest"; then echo "install-git-hooks: pre-push already installed at $dest"; exit 0; fi
  echo "install-git-hooks: refusing to overwrite existing different hook $dest" >&2; exit 1
fi
mkdir -p "$hooks"
cp "$src" "$dest"
chmod 755 "$dest"
echo "install-git-hooks: installed $dest"

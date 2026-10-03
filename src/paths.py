"""Portable paths for the standalone harness utilities."""

from __future__ import annotations

import os
from pathlib import Path


def state_dir() -> Path:
    configured = os.environ.get("HARNESS_STATE_DIR")
    return Path(configured).expanduser() if configured else Path.home() / ".local" / "state" / "opencode-usage-harness"


def quota_cache_path() -> Path:
    return state_dir() / "quota" / "cache.json"


def ownership_dir() -> Path:
    return state_dir() / "dispatch-ownership"


def opencode_db() -> Path:
    configured = os.environ.get("HARNESS_OPENCODE_DB")
    if not configured:
        raise RuntimeError("HARNESS_OPENCODE_DB is required")
    return Path(configured).expanduser()

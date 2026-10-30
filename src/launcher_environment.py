"""Preserve GitHub CLI configuration when a launcher isolates XDG directories.

Call before replacing XDG_CONFIG_HOME. Return a path reference only: never copy
credential files, inspect their contents, or forward token environment variables.
"""
from pathlib import Path


def github_cli_environment(*, home, original_env):
    home_path = Path(home)
    if not home_path.is_absolute():
        raise ValueError('launcher home must be absolute')
    configured = original_env.get('GH_CONFIG_DIR')
    if configured:
        selected = Path(configured)
    elif original_env.get('XDG_CONFIG_HOME'):
        selected = Path(original_env['XDG_CONFIG_HOME']) / 'gh'
    else:
        selected = home_path / '.config' / 'gh'
    if not selected.is_absolute():
        raise ValueError('GitHub CLI configuration directory must be absolute')
    return {'GH_CONFIG_DIR': str(selected)}

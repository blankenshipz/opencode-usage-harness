import unittest
from src.launcher_environment import github_cli_environment


class LauncherEnvironmentTests(unittest.TestCase):
    def test_default_preserves_user_config_without_tokens(self):
        self.assertEqual(github_cli_environment(home='/home/example', original_env={'GH_TOKEN': 'private', 'OPENAI_API_KEY': 'private'}),
                         {'GH_CONFIG_DIR': '/home/example/.config/gh'})

    def test_explicit_github_directory_wins_and_survives_nested_launcher(self):
        source = {'GH_CONFIG_DIR': '/srv/github config', 'XDG_CONFIG_HOME': '/srv/isolated'}
        self.assertEqual(github_cli_environment(home='/home/example', original_env=source), {'GH_CONFIG_DIR': '/srv/github config'})

    def test_original_xdg_is_preserved_before_isolation(self):
        self.assertEqual(github_cli_environment(home='/home/example', original_env={'XDG_CONFIG_HOME': '/srv/user-config'}),
                         {'GH_CONFIG_DIR': '/srv/user-config/gh'})

    def test_relative_configuration_is_rejected(self):
        for env in [{'GH_CONFIG_DIR': 'relative'}, {'XDG_CONFIG_HOME': 'relative'}]:
            with self.assertRaises(ValueError):
                github_cli_environment(home='/home/example', original_env=env)

import unittest
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from configure import profile

class ConfigureTests(unittest.TestCase):
    def test_roles_and_safe_public_defaults(self):
        p=profile({k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')})
        self.assertEqual(p['enabled_providers'],['openai'])
        self.assertEqual(p['permissions'][0]['effect'],'ask')
        for role in ('scout','builder','quick-builder','reviewer'):
            self.assertIn({'action':'large_file_summary','resource':'*','effect':'deny'},p['agents'][role]['permissions'])
        self.assertEqual(len(p['plugins']),4)
    def test_models_must_be_explicit_openai_variants(self):
        for invalid in ('other/model#medium','openai/model','openai/model#'):
            with self.assertRaises(ValueError):profile({k:invalid for k in ('FAST','BALANCED','STRONG','MAXIMUM')})

if __name__=='__main__':unittest.main()

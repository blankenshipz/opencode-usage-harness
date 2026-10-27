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
        for name in ('build','plan','general','explore'):
            self.assertFalse(p['agents'][name]['disabled'])
            self.assertNotIn('system',p['agents'][name])
            self.assertNotIn('model',p['agents'][name])
            self.assertIn({'action':'task_*','resource':'*','effect':'deny'},p['agents'][name]['permissions'])
        self.assertIn({'action':'edit','resource':'*','effect':'deny'},p['agents']['plan']['permissions'])
        self.assertIn({'action':'edit','resource':'~/.opencode/plan/*','effect':'allow'},p['agents']['plan']['permissions'])
    def test_explicit_pool_policy_enables_only_declared_providers(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        p=profile(models,routing_policy={'version':1,'enabled':True,'roles':{'builder':[{'ref':'anthropic/fixture#high'}]}})
        self.assertEqual(set(p['enabled_providers']),{'openai','anthropic'})
        self.assertEqual(p['experimental']['policies'][0],{'action':'provider.use','resource':'*','effect':'deny'})
        with self.assertRaises(ValueError):
            profile(models,routing_policy={'version':1,'roles':{'builder':[{'ref':'paid/fixture#high'}]}})

    def test_models_must_be_explicit_openai_variants(self):
        for invalid in ('other/model#medium','openai/model','openai/model#'):
            with self.assertRaises(ValueError):profile({k:invalid for k in ('FAST','BALANCED','STRONG','MAXIMUM')})

if __name__=='__main__':unittest.main()

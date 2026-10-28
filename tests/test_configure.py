import unittest
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from configure import profile, namespace_harness_agents

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
        verifier = p['agents']['harness-verifier']
        self.assertIn({'action':'edit','resource':'*','effect':'deny'}, verifier['permissions'])
        self.assertNotIn({'action':'shell','resource':'*','effect':'deny'}, verifier['permissions'])
        self.assertIn('not a read-only sandbox', verifier['system'])
        self.assertEqual(p['default_agent'], 'harness-router')
        for role in ('router','builder','quick-builder','reviewer'):
            self.assertFalse(p['agents'][f'harness-{role}'].get('hidden', False))
            self.assertTrue(p['agents'][role]['hidden'])
        router_children = {(r['action'], r['resource']) for r in p['agents']['harness-router']['permissions']}
        self.assertIn(('subagent', 'builder'), router_children)
        self.assertIn(('subagent', 'harness-builder'), router_children)

    def test_task_fit_policy_validation(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        def policy(rule):
            return {'version':1,'enabled':True,'roles':{'builder':[{'ref':'openai/fixture#medium','taskFit':{'implementation':rule}}]}}
        good={'band':'preferred','evidence_status':'supported','evidence_ref':'fixture-receipt'}
        self.assertEqual(profile(models,routing_policy=policy(good))['enabled_providers'],['openai'])
        self.assertEqual(profile(models,routing_policy=policy({'band':'preferred','evidence_status':'provisional'}))['enabled_providers'],['openai'])
        for rule in [None,{'band':'winner','evidence_status':'supported'}, {'band':'preferred','evidence_status':'supported'}, {**good,'evidence_ref':'private\ntext'}, {**good,'unknown':True}]:
            with self.assertRaises(ValueError):profile(models,routing_policy=policy(rule))
        bad=policy(good);bad['roles']['builder'][0]['taskFit']={'invented':good}
        with self.assertRaises(ValueError):profile(models,routing_policy=bad)

    def test_namespace_helper_is_idempotent_and_preserves_hidden_compatibility(self):
        agents = {'router': {'system': 'router', 'permissions': [
            {'action': 'subagent', 'resource': 'builder', 'effect': 'allow'},
            {'action': 'subagent', 'resource': '*', 'effect': 'deny'}]},
            'builder': {'system': 'builder', 'permissions': []},
            'builder-high': {'system': 'high', 'hidden': True, 'permissions': []},
            'unrelated': {'system': 'untouched'}}
        migrated = namespace_harness_agents(agents)
        self.assertTrue(migrated['router']['hidden'])
        self.assertFalse(migrated['harness-router']['hidden'])
        self.assertTrue(migrated['builder-high']['hidden'])
        self.assertTrue(migrated['harness-builder-high']['hidden'])
        self.assertEqual(migrated['harness-router']['permissions'][:2], [
            {'action': 'subagent', 'resource': 'builder', 'effect': 'allow'},
            {'action': 'subagent', 'resource': 'harness-builder', 'effect': 'allow'}])
        again = namespace_harness_agents(migrated)
        self.assertEqual(again, migrated)
        self.assertEqual(again['unrelated'], agents['unrelated'])
    def test_explicit_pool_policy_enables_only_declared_providers(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        p=profile(models,routing_policy={'version':1,'enabled':True,'roles':{'builder':[{'ref':'anthropic/fixture#high'}]}})
        self.assertEqual(set(p['enabled_providers']),{'openai','anthropic'})
        self.assertEqual(p['experimental']['policies'][0],{'action':'provider.use','resource':'*','effect':'deny'})
        with self.assertRaises(ValueError):
            profile(models,routing_policy={'version':1,'roles':{'builder':[{'ref':'paid/fixture#high'}]}})

    def test_tiers_can_be_openai_anthropic_or_mixed(self):
        tiers = ('FAST','BALANCED','STRONG','MAXIMUM')
        self.assertEqual(profile({k:'anthropic/fixture#medium' for k in tiers})['enabled_providers'], ['anthropic'])
        self.assertEqual(profile({k:('openai/fixture#medium' if k == 'FAST' else 'anthropic/fixture#medium') for k in tiers})['enabled_providers'], ['openai','anthropic'])

    def test_disabled_policy_does_not_activate_candidate_provider(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        policy={'version':1,'enabled':False,'roles':{'builder':[{'ref':'anthropic/fixture#high'}]}}
        self.assertEqual(profile(models,routing_policy=policy)['enabled_providers'], ['openai'])
        policy['enabled']=True
        policy['roles']['builder'][0]['enabled']=False
        self.assertEqual(profile(models,routing_policy=policy)['enabled_providers'], ['openai'])

    def test_malformed_policy_is_value_error(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        for policy in (
            None,
            {'version':1,'roles':{'builder':[None]}},
            {'version':1,'roles':{'builder':[{}]}},
            {'version':1,'enabled':'yes','roles':{}},
        ):
            if policy is not None:
                with self.assertRaises(ValueError):
                    profile(models,routing_policy=policy)

    def test_routing_policy_schema_rejects_unknown_keys_and_bad_references(self):
        models={k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        valid={'version':1,'enabled':True,'reservePercent':2,'profiles':{'measured':{}},'roles':{
            'builder':[{'ref':'openai/fixture#medium','profile':'measured','requiresScopedQuota':False}]}}
        self.assertEqual(profile(models,routing_policy=valid)['enabled_providers'], ['openai'])
        for mutate in (
            lambda p:p.update({'unknown':True}),
            lambda p:p.update({'reservePercent':'2'}),
            lambda p:p['roles']['builder'][0].update({'requiresScopedQuota':'false'}),
            lambda p:p['roles']['builder'][0].update({'profile':'missing'}),
            lambda p:p['roles']['builder'][0].update({'unknown':True}),
            lambda p:p.update({'roles':{'harness-imposter':p['roles']['builder']}}),
        ):
            with self.subTest(mutate=mutate):
                policy=copy.deepcopy(valid)
                mutate(policy)
                with self.assertRaises(ValueError):
                    profile(models,routing_policy=policy)
        alias=copy.deepcopy(valid)
        alias['roles']={'harness-verifier':alias['roles']['builder']}
        self.assertEqual(profile(models,routing_policy=alias)['enabled_providers'], ['openai'])

    def test_models_must_be_explicit_subscription_variants(self):
        for invalid in ('other/model#medium','openai/model','openai/model#','anthropic/model#'):
            with self.assertRaises(ValueError):profile({k:invalid for k in ('FAST','BALANCED','STRONG','MAXIMUM')})

    def test_replace_without_policy_backs_up_and_removes_stale_policy(self):
        tiers = ('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            models=root/'models.json'; models.write_text(json.dumps({k:'openai/fixture#medium' for k in tiers}))
            state=root/'state'; config=state/'config'; config.mkdir(parents=True)
            (config/'opencode.json').write_text('{}')
            (config/'routing-policy.json').write_text('{"version": 1, "enabled": true}')
            financial=config/'financial-verification.json'; financial.write_text('{"verified_at":"kept"}')
            subprocess.run([sys.executable, 'configure.py', '--models', str(models), '--state-dir', str(state), '--replace'], check=True)
            self.assertFalse((config/'routing-policy.json').exists())
            backups=list(config.glob('routing-policy.backup-*.json'))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_text(), '{"version": 1, "enabled": true}')
            self.assertEqual(financial.read_text(), '{"verified_at":"kept"}')

    def test_orphaned_policy_is_backed_up_without_existing_profile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); state=root/'state'; config=state/'config';config.mkdir(parents=True)
            models=root/'models.json';models.write_text(json.dumps({k:'anthropic/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}))
            (config/'routing-policy.json').write_text('{"version":1,"enabled":true}')
            subprocess.run([sys.executable,'configure.py','--models',str(models),'--state-dir',str(state)],check=True,capture_output=True)
            self.assertFalse((config/'routing-policy.json').exists())
            self.assertEqual(len(list(config.glob('routing-policy.backup-*.json'))),1)

    def test_anthropic_only_profile_does_not_create_financial_placeholder(self):
        tiers = ('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            models=root/'models.json'; models.write_text(json.dumps({k:'anthropic/fixture#medium' for k in tiers}))
            state=root/'state'
            subprocess.run([sys.executable, 'configure.py', '--models', str(models), '--state-dir', str(state)], check=True)
            self.assertFalse((state/'config'/'financial-verification.json').exists())

if __name__=='__main__':unittest.main()

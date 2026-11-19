import re
import unittest
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from configure import profile, namespace_harness_agents, DANGEROUS_SHELL_ASK, ENV_TEMPLATE_SHELL_ALLOW, ALLOWLIST_SHELL_ALLOW, BUILDER_FILE_WRITE_GUIDANCE, atomic_write_text

class ConfigureTests(unittest.TestCase):
    def test_roles_and_safe_public_defaults(self):
        p=profile({k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')})
        self.assertEqual(p['enabled_providers'],['openai'])
        self.assertEqual(p['permissions'][0]['effect'],'ask')
        protected = {'action':'edit','resource':'*anthropic-financial-policy.json','effect':'deny'}
        external_grants = {'action':'edit','resource':'*external-write-grants.json','effect':'deny'}
        self.assertIn(protected, p['permissions'])
        self.assertIn(external_grants, p['permissions'])
        for role in ('scout','builder','quick-builder','reviewer'):
            self.assertIn({'action':'large_file_summary','resource':'*','effect':'deny'},p['agents'][role]['permissions'])
            self.assertIn(protected,p['agents'][role]['permissions'])
            self.assertIn(external_grants,p['agents'][role]['permissions'])
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

    def test_delegating_roles_register_intent_before_first_handoff(self):
        p=profile({k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')})
        for role in ('harness-router','router','harness-coordinator','coordinator'):
            system=p['agents'][role]['system']
            self.assertIn("Before the first task_dispatch/subagent handoff of a taskId: call task_intent", system)
            self.assertIn("action:'set', expectedRevision:0", system)
            self.assertIn('as intentRevision and the chosen check ids as checkIds', system)
        for role in ('harness-builder','harness-verifier','harness-scout'):
            self.assertNotIn('Before the first task_dispatch/subagent handoff', p['agents'][role]['system'])

    def test_only_delegating_roles_may_cancel_their_children(self):
        p=profile({k:'openai/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')})
        def effect(agent):
            rules=[r for r in p['agents'][agent]['permissions'] if r['action'] in ('task_dispatch_cancel','task_*')]
            return rules[-1]['effect'] if rules else None
        for role in ('harness-router','router','harness-coordinator','coordinator'):
            self.assertEqual(effect(role),'allow')
            self.assertIn('task_dispatch_cancel', p['agents'][role]['system'])
        for role in ('harness-builder','harness-verifier','harness-scout','harness-reviewer','builder'):
            self.assertEqual(effect(role),'deny')
            self.assertNotIn('task_dispatch_cancel', p['agents'][role]['system'])
        for builtin in ('build','plan','general','explore'):
            self.assertEqual(effect(builtin),'deny')
        self.assertNotIn('task_dispatch_cancel', {r['action'] for r in p['permissions'] if r['effect']=='allow'})

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

    def test_verifier_artifacts_keep_secret_denials_and_production_readonly(self):
        import fnmatch
        p = profile({t: 'openai/example#medium' for t in ('FAST','BALANCED','STRONG','MAXIMUM')})
        rules = p['agents']['harness-verifier']['permissions']
        def effect(resource):
            matches = [r['effect'] for r in rules if r['action'] == 'edit' and fnmatch.fnmatchcase(resource,r['resource'])]
            return matches[-1]
        for resource in ('.artifacts/check/test_case.py','/workspace/.artifacts/check/input.json'):
            self.assertEqual(effect(resource), 'allow')
        for resource in ('app/main.py','/workspace/app/main.py','.artifacts/check/.env',
                         '.artifacts/check/auth.json','.artifacts/check/private.key',
                         '.artifacts/check/external-write-grants.json'):
            self.assertEqual(effect(resource), 'deny')

    def test_env_templates_are_not_secrets_but_real_env_files_stay_protected(self):
        def native(rules, action, resource):
            # OpenCode 2.0.30 Wildcard.match + Permission.evaluate: last matching rule wins.
            def match(value, pattern):
                escaped = re.sub(r'[.+^${}()|[\]\\]', lambda m: '\\'+m.group(0), pattern).replace('*','.*').replace('?','.')
                if escaped.endswith(' .*'): escaped = escaped[:-3]+'( .*)?'
                return re.fullmatch(escaped, value, re.S) is not None
            found = [r['effect'] for r in rules if match(action, r['action']) and match(resource, r['resource'])]
            return found[-1] if found else None
        templates = ('.env.example','apps/api/.env.sample','/workspace/app/.env.template')
        secrets = ('.env','.env.local','apps/api/.env.production','/w/.env.development.local','.env.example.bak','id.key')
        for policy in ('allowlist','permissive'):
            p = profile({t:'openai/example#medium' for t in ('FAST','BALANCED','STRONG','MAXIMUM')}, shell_policy=policy)
            builder = p['permissions'] + p['agents']['harness-builder']['permissions']
            for action in ('read','edit'):
                for resource in templates: self.assertEqual(native(builder, action, resource), 'allow', (policy, action, resource))
                for resource in secrets: self.assertEqual(native(builder, action, resource), 'deny', (policy, action, resource))
            # Read-only roles still cannot edit templates.
            scout = p['permissions'] + p['agents']['harness-scout']['permissions']
            self.assertEqual(native(scout, 'edit', '.env.example'), 'deny')
            verifier = p['permissions'] + p['agents']['harness-verifier']['permissions']
            self.assertEqual(native(verifier, 'edit', 'app/.env.example'), 'deny')
            self.assertEqual(native(verifier, 'edit', '.artifacts/check/.env.example'), 'allow')
            self.assertEqual(native(verifier, 'edit', '/w/.artifacts/.env.sample'), 'allow')
            self.assertEqual(native(verifier, 'edit', '.artifacts/check/.env.local'), 'deny')
            if policy == 'permissive':
                for command in ('cat .env.example','cat apps/api/.env.sample','head -5 .env.template'):
                    self.assertEqual(native(builder, 'shell', command), 'allow', command)
                for command in ('cat .env','cat .env.local','cat .env.example.bak','rm -rf .env.example','git commit -m x .env.example'):
                    self.assertEqual(native(builder, 'shell', command), 'ask', command)
            else:
                self.assertFalse(any(r['resource'] in ENV_TEMPLATE_SHELL_ALLOW for r in builder if r['action']=='shell'))

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

    def test_generated_policy_protects_financial_opt_in_in_default_and_explicit_state_directories(self):
        tiers=('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); models=root/'models.json';models.write_text(json.dumps({k:'anthropic/fixture#medium' for k in tiers}))
            default_state=root/'default-state'; alternate_state=root/'alternate-state'
            env={**os.environ,'HARNESS_STATE_DIR':str(default_state)}
            subprocess.run([sys.executable,'configure.py','--models',str(models)],check=True,env=env,capture_output=True)
            subprocess.run([sys.executable,'configure.py','--models',str(models),'--state-dir',str(alternate_state)],check=True,capture_output=True)
            protected={'action':'edit','resource':'*anthropic-financial-policy.json','effect':'deny'}
            for state in (default_state,alternate_state):
                generated=json.loads((state/'config'/'opencode.json').read_text())
                self.assertIn(protected,generated['permissions'])
                self.assertIn(protected,generated['agents']['harness-builder']['permissions'])

    def test_shell_policy_allowlist_default_and_permissive_option(self):
        models={k:'anthropic/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')}
        default=profile(models)
        shell=[r for r in default['permissions'] if r['action']=='shell']
        self.assertEqual(shell,[{'action':'shell','resource':c,'effect':'allow'} for c in ALLOWLIST_SHELL_ALLOW])
        self.assertNotIn({'action':'shell','resource':'*','effect':'allow'},default['permissions'])
        self.assertEqual(default['permissions'][0],{'action':'*','resource':'*','effect':'ask'})
        permissive=profile(models,shell_policy='permissive')
        shell=[r for r in permissive['permissions'] if r['action']=='shell']
        self.assertEqual(shell[0],{'action':'shell','resource':'*','effect':'allow'})
        asks=[r['resource'] for r in shell[1:] if r['effect']=='ask']
        self.assertEqual(sorted(asks),sorted(DANGEROUS_SHELL_ASK))
        self.assertTrue(all(r['effect']=='ask' or r['resource'] in ENV_TEMPLATE_SHELL_ALLOW for r in shell[1:]))
        for required in ('git push*','sudo *','rm -rf *','*.env*','bash -*','eval *','git commit*'):
            self.assertIn(required,DANGEROUS_SHELL_ASK)
        # Read-only roles keep their agent-level shell deny, which follows the global allow.
        for role in ('harness-router','harness-scout','harness-reviewer'):
            self.assertIn({'action':'shell','resource':'*','effect':'deny'},permissive['agents'][role]['permissions'])
        for generated in (default,permissive):
            for role in ('harness-builder','harness-quick-builder','builder'):
                self.assertTrue(generated['agents'][role]['system'].endswith(BUILDER_FILE_WRITE_GUIDANCE))
            self.assertNotIn(BUILDER_FILE_WRITE_GUIDANCE,generated['agents']['harness-verifier']['system'])
        with self.assertRaises(ValueError):
            profile(models,shell_policy='yolo')

    def test_tmp_scratch_is_opt_in_persisted_and_narrow(self):
        tiers=('FAST','BALANCED','STRONG','MAXIMUM')
        rule={'action':'external_directory','resource':'/tmp/*','effect':'allow'}
        models={k:'anthropic/fixture#medium' for k in tiers}
        base,scratch=profile(models,shell_policy='permissive'),profile(models,shell_policy='permissive',tmp_scratch=True)
        self.assertNotIn(rule,base['permissions'])
        self.assertIn(rule,scratch['permissions'])
        # Nothing else changes, and no agent overrides external_directory.
        self.assertEqual([r for r in scratch['permissions'] if r!=rule],base['permissions'])
        self.assertEqual(scratch['agents'],base['agents'])
        self.assertFalse(any(r['action']=='external_directory' for a in scratch['agents'].values() for r in a.get('permissions',[])))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); mfile=root/'models.json'; mfile.write_text(json.dumps(models))
            state=root/'state'; config=state/'config'
            run=lambda *extra: subprocess.run([sys.executable,'configure.py','--models',str(mfile),'--state-dir',str(state),*extra],check=True,capture_output=True,text=True)
            out=run('--allow-tmp-scratch')
            self.assertIn('/tmp scratch (external_directory /tmp/*): allowed',out.stdout)
            self.assertIn(rule,json.loads((config/'opencode.json').read_text())['permissions'])
            run('--replace')  # persisted
            self.assertIn(rule,json.loads((config/'opencode.json').read_text())['permissions'])
            run('--replace','--no-allow-tmp-scratch')
            self.assertNotIn(rule,json.loads((config/'opencode.json').read_text())['permissions'])
            self.assertFalse(json.loads((config/'configure-choices.json').read_text())['tmp_scratch'])

    def test_readonly_roles_get_repo_identity_instead_of_shell(self):
        p=profile({k:'anthropic/fixture#medium' for k in ('FAST','BALANCED','STRONG','MAXIMUM')})
        self.assertIn({'action':'repo_identity','resource':'*','effect':'allow'},p['permissions'])
        router=p['agents']['harness-router']
        self.assertIn({'action':'shell','resource':'*','effect':'deny'},router['permissions'])
        self.assertIn('repo_identity',router['system'])
        self.assertNotIn('repo_identity',p['agents']['harness-builder']['system'])

    def test_shell_policy_choice_is_persisted_across_replace(self):
        tiers=('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); models=root/'models.json'; models.write_text(json.dumps({k:'anthropic/fixture#medium' for k in tiers}))
            state=root/'state'; config=state/'config'
            run=lambda *extra: subprocess.run([sys.executable,'configure.py','--models',str(models),'--state-dir',str(state),*extra],check=True,capture_output=True,text=True)
            run()
            self.assertEqual(json.loads((config/'configure-choices.json').read_text()),{'shell_policy':'allowlist','tmp_scratch':False})
            out=run('--replace','--shell-policy','permissive')
            self.assertIn('Shell policy: permissive',out.stdout)
            generated=json.loads((config/'opencode.json').read_text())
            self.assertIn({'action':'shell','resource':'*','effect':'allow'},generated['permissions'])
            run('--replace')  # no flag: keeps the persisted permissive choice
            generated=json.loads((config/'opencode.json').read_text())
            self.assertIn({'action':'shell','resource':'*','effect':'allow'},generated['permissions'])
            run('--replace','--shell-policy','allowlist')
            generated=json.loads((config/'opencode.json').read_text())
            self.assertNotIn({'action':'shell','resource':'*','effect':'allow'},generated['permissions'])
            self.assertEqual(oct((config/'opencode.json').stat().st_mode & 0o777),'0o600')
            self.assertEqual([p.name for p in config.iterdir() if p.name.endswith('.tmp')],[])
            (config/'configure-choices.json').write_text('{"shell_policy":"bogus"}')
            bad=subprocess.run([sys.executable,'configure.py','--models',str(models),'--state-dir',str(state),'--replace'],capture_output=True,text=True)
            self.assertNotEqual(bad.returncode,0)

    @staticmethod
    def fake_claude_auth(directory, name='opencode-claude-auth', version='3.0.0'):
        directory=Path(directory); (directory/'dist').mkdir(parents=True)
        (directory/'package.json').write_text(json.dumps({'name':name,'version':version}))
        (directory/'index.mjs').write_text('export * from "./dist/index.js"\n')
        (directory/'dist'/'index.js').write_text('export default {}\n')
        return directory

    def test_claude_auth_plugin_entry_only_for_anthropic_and_verified_build(self):
        from configure import verified_claude_auth_plugin, find_claude_auth_plugin
        tiers=('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            release=Path(tmp)/'prefix'/'releases'/'0.2.0'
            plugin=self.fake_claude_auth(release/'plugins'/'v2'/'claude-auth')
            self.assertEqual(find_claude_auth_plugin(release),plugin.resolve())
            claude=profile({k:'anthropic/fixture#medium' for k in tiers},claude_auth_plugin=plugin)
            self.assertEqual(claude['plugins'][-1],plugin.resolve().as_uri())
            self.assertEqual(len(claude['plugins']),5)
            openai=profile({k:'openai/fixture#medium' for k in tiers},claude_auth_plugin=plugin)
            self.assertNotIn(plugin.resolve().as_uri(),openai['plugins'])
            self.assertEqual(len(profile({k:'anthropic/fixture#medium' for k in tiers})['plugins']),4)
            # <prefix>/vendor/claude-auth is detected when the release has none.
            other=Path(tmp)/'p2'/'releases'/'0.3.0'; other.mkdir(parents=True)
            vendor=self.fake_claude_auth(Path(tmp)/'p2'/'vendor'/'claude-auth')
            self.assertEqual(find_claude_auth_plugin(other),vendor.resolve())
            for bad in (self.fake_claude_auth(Path(tmp)/'wrongname',name='other'),
                        self.fake_claude_auth(Path(tmp)/'wrongversion',version='3.0.1'),Path(tmp)/'missing'):
                self.assertIsNone(verified_claude_auth_plugin(bad))
            unbuilt=self.fake_claude_auth(Path(tmp)/'unbuilt'); (unbuilt/'dist'/'index.js').unlink()
            self.assertIsNone(verified_claude_auth_plugin(unbuilt))

    def test_configure_cli_generates_persists_and_carries_forward_claude_auth(self):
        tiers=('FAST','BALANCED','STRONG','MAXIMUM')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); models=root/'models.json'; models.write_text(json.dumps({k:'anthropic/fixture#medium' for k in tiers}))
            state=root/'state'; config=state/'config'
            plugin=self.fake_claude_auth(root/'vendor'/'claude-auth')
            run=lambda *extra: subprocess.run([sys.executable,'configure.py','--models',str(models),'--state-dir',str(state),*extra],capture_output=True,text=True)
            out=run()
            self.assertEqual(out.returncode,0,out.stderr); self.assertIn('WARNING',out.stdout)
            self.assertFalse(any(u.endswith('/claude-auth') for u in json.loads((config/'opencode.json').read_text())['plugins']))
            out=run('--replace','--claude-auth-plugin',str(plugin),'--shell-policy','permissive')
            self.assertEqual(out.returncode,0,out.stderr)
            self.assertIn(plugin.resolve().as_uri(),json.loads((config/'opencode.json').read_text())['plugins'])
            self.assertEqual(json.loads((config/'configure-choices.json').read_text())['claude_auth_plugin'],str(plugin.resolve()))
            out=run('--replace')  # persisted choice keeps the entry
            self.assertIn(plugin.resolve().as_uri(),json.loads((config/'opencode.json').read_text())['plugins'])
            # Without a persisted choice, a still-valid entry in the replaced profile is carried forward.
            (config/'configure-choices.json').write_text('{"shell_policy":"permissive"}')
            out=run('--replace')
            self.assertIn(plugin.resolve().as_uri(),json.loads((config/'opencode.json').read_text())['plugins'])
            self.assertNotIn('WARNING',out.stdout)
            bad=run('--replace','--claude-auth-plugin',str(root/'nope'))
            self.assertNotEqual(bad.returncode,0)
            (config/'configure-choices.json').write_text(json.dumps({'shell_policy':'permissive','claude_auth_plugin':str(root/'nope')}))
            self.assertNotEqual(run('--replace').returncode,0)

    def test_profile_write_is_atomic_rename(self):
        with tempfile.TemporaryDirectory() as tmp:
            target=Path(tmp)/'opencode.json'; target.write_text('{"old":true}')
            inode=target.stat().st_ino
            atomic_write_text(target,'{"new":true}\n')
            self.assertEqual(target.read_text(),'{"new":true}\n')
            # Replaced by rename (new inode), never truncated in place.
            self.assertNotEqual(target.stat().st_ino,inode)
            self.assertEqual(oct(target.stat().st_mode & 0o777),'0o600')
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()),['opencode.json'])

if __name__=='__main__':unittest.main()

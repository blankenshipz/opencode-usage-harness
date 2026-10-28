#!/usr/bin/env python3
"""Prepare an isolated OpenCode V2 profile; never migrate or start a service."""
import argparse
import copy
import json
import os
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TASK_TYPES = {'general','exploration','mechanical','implementation','debugging','architecture','testing','review'}


def validate_task_fit(candidate):
    if 'taskFit' not in candidate:
        return
    rules = candidate['taskFit']
    if not isinstance(rules, dict) or not set(rules).issubset(TASK_TYPES):
        raise ValueError('invalid candidate task-fit policy')
    for rule in rules.values():
        if (not isinstance(rule, dict) or not set(rule).issubset({'band','evidence_status','evidence_ref'})
                or rule.get('band') not in ('preferred','acceptable')
                or rule.get('evidence_status') not in ('provisional','supported')):
            raise ValueError('invalid candidate task-fit rule')
        ref = rule.get('evidence_ref')
        if 'evidence_ref' in rule and (not isinstance(ref, str) or not ref.strip() or len(ref) > 240 or any(c in ref for c in '\r\n\0')):
            raise ValueError('invalid task-fit evidence reference')
        if rule['band'] == 'preferred' and rule['evidence_status'] == 'supported' and ref is None:
            raise ValueError('supported task-fit preference requires evidence reference')


def validate_routing_policy(routing_policy):
    allowed_policy_keys = {'version','enabled','reservePercent','roles','profiles'}
    allowed_candidate_keys = {'ref','profile','enabled','requiresScopedQuota','taskFit'}
    if (not isinstance(routing_policy, dict) or set(routing_policy) - allowed_policy_keys
            or routing_policy.get('version') != 1 or not isinstance(routing_policy.get('roles'), dict)):
        raise ValueError('routing policy must use version 1 and explicit role candidates')
    if 'enabled' in routing_policy and not isinstance(routing_policy['enabled'], bool):
        raise ValueError('routing policy enabled must be a boolean')
    reserve = routing_policy.get('reservePercent')
    if reserve is not None and (isinstance(reserve, bool) or not isinstance(reserve, (int, float)) or not 0 <= reserve <= 10):
        raise ValueError('routing policy reservePercent must be a number from zero through ten')
    profiles = routing_policy.get('profiles')
    if profiles is not None:
        if not isinstance(profiles, dict) or any(not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', name) or not isinstance(value, dict) for name, value in profiles.items()):
            raise ValueError('routing policy profiles must be named objects')
    for role, candidates in routing_policy['roles'].items():
        if role not in NAMESPACED_ROLES and not (role.startswith('harness-') and role.removeprefix('harness-') in NAMESPACED_ROLES):
            raise ValueError('routing policy roles must use a configured harness ID')
        if not isinstance(candidates, list):
            raise ValueError('routing role candidates must be lists')
        for candidate in candidates:
            if not isinstance(candidate, dict) or set(candidate) - allowed_candidate_keys:
                raise ValueError('routing candidates must be policy objects')
            if 'enabled' in candidate and not isinstance(candidate['enabled'], bool):
                raise ValueError('routing candidate enabled must be a boolean')
            if 'requiresScopedQuota' in candidate and not isinstance(candidate['requiresScopedQuota'], bool):
                raise ValueError('routing candidate requiresScopedQuota must be a boolean')
            ref = candidate.get('ref')
            if not isinstance(ref, str) or not re.fullmatch(r'(openai|anthropic)/[A-Za-z0-9._-]+#[A-Za-z0-9_-]+', ref):
                raise ValueError('routing candidates must be discovered subscription model variants')
            profile_ref = candidate.get('profile')
            if profile_ref is not None and (not isinstance(profile_ref, str) or not re.fullmatch(r'[A-Za-z0-9._-]+', profile_ref) or (profiles is not None and profile_ref not in profiles)):
                raise ValueError('routing candidate profile must be a declared profile reference')
            validate_task_fit(candidate)


NAMESPACED_ROLES = ('router','coordinator','scout','quick-builder','builder','builder-high','deep-debugger','deep-debugger-high','architect','reviewer','verifier','maximum','maximum-max')
ROLES = {
    'router': ('STRONG', True, True),
    'coordinator': ('BALANCED', True, True),
    'scout': ('FAST', False, True),
    'quick-builder': ('FAST', False, False),
    'builder': ('BALANCED', False, False),
    'deep-debugger': ('STRONG', False, False),
    'architect': ('STRONG', False, True),
    'reviewer': ('STRONG', False, True),
    'verifier': ('STRONG', False, False),
    'maximum': ('MAXIMUM', False, False),
}

def visible_role(role):
    return f'harness-{role}'

def namespace_harness_agents(agents):
    """Return a config with visible harness IDs and exact-ID compatibility aliases.

    This is intentionally a pure transformation for an already customized live
    config: models, prompts, permissions, modes, and existing hidden flags are
    copied. Existing IDs remain valid for persisted sessions; only new aliases
    are added. High-effort roles keep their configured hidden state.
    """
    result = copy.deepcopy(agents)
    for role in NAMESPACED_ROLES:
        old = result.get(role)
        if not isinstance(old, dict):
            continue
        visible = visible_role(role)
        if visible not in result:
            alias = copy.deepcopy(old)
            if role in ('builder-high','deep-debugger-high','maximum-max'):
                alias['hidden'] = bool(old.get('hidden', True))
            else:
                alias['hidden'] = False
            result[visible] = alias
        old['hidden'] = True
        guidance = ('\nUse visible harness-* IDs for new handoffs. When continuing an existing worker, '
                    'pass its exact stored agent ID and sessionID; never rename or adopt it.')
        for agent_id in (role, visible):
            if guidance not in result[agent_id].get('system', ''):
                result[agent_id]['system'] = result[agent_id].get('system', '') + guidance
        for agent_id in (role, visible):
            permissions = result[agent_id].setdefault('permissions', [])
            existing = {(entry.get('action'), entry.get('resource'), entry.get('effect')) for entry in permissions}
            expanded = []
            for entry in permissions:
                expanded.append(entry)
                if entry.get('action') == 'subagent' and entry.get('resource') in NAMESPACED_ROLES:
                    alias = {**entry, 'resource': visible_role(entry['resource'])}
                    key = (alias.get('action'), alias.get('resource'), alias.get('effect'))
                    if key not in existing:
                        expanded.append(alias)
                        existing.add(key)
            permissions[:] = expanded
    return result

def profile(models, package_root=ROOT, routing_policy=None):
    if not isinstance(models, dict):
        raise ValueError('models must be a tier-reference object')
    for tier in ('FAST', 'BALANCED', 'STRONG', 'MAXIMUM'):
        if not isinstance(models.get(tier), str) or not re.fullmatch(r'(openai|anthropic)/[A-Za-z0-9._-]+#[A-Za-z0-9_-]+', models[tier]):
            raise ValueError(f'{tier} must be an actual discovered openai or anthropic model#variant reference')
    providers = []
    for tier in ('FAST', 'BALANCED', 'STRONG', 'MAXIMUM'):
        provider = models[tier].split('/', 1)[0]
        if provider not in providers:
            providers.append(provider)
    if routing_policy is not None:
        validate_routing_policy(routing_policy)
        for candidates in routing_policy['roles'].values():
            for candidate in candidates:
                ref = candidate['ref']
                if routing_policy.get('enabled') is True and candidate.get('enabled', True) is not False:
                    provider = ref.split('/')[0]
                    if provider not in providers:
                        providers.append(provider)
    prompts = json.loads((package_root/'config/instructions.json').read_text())
    agents = {}
    for role, (tier, delegate, readonly) in ROLES.items():
        rules = [{'action':'subagent','resource':'*','effect':'deny'},
                 {'action':'large_file_summary','resource':'*','effect':'allow' if delegate else 'deny'},
                 {'action':'large_file_allow_direct','resource':'*','effect':'deny' if readonly else 'allow'},
                 {'action':'task_dispatch','resource':'*','effect':'allow' if delegate else 'deny'}]
        if delegate:
            children = [child for child in ROLES if child != 'router' and (role == 'router' or child != 'coordinator')]
            rules += [{'action':'subagent','resource':child_id,'effect':'allow'}
                      for child in children for child_id in (child, visible_role(child))]
        if readonly:
            rules += [{'action':a,'resource':'*','effect':'deny'} for a in ('shell','edit')]
        if role == 'verifier':
            rules.append({'action':'edit','resource':'*','effect':'deny'})
        identity_guidance = ('\nUse visible harness-* IDs for new handoffs. When continuing an existing worker, '
                             'pass its exact stored agent ID and sessionID; never rename or adopt it.')
        definition = {'description':f'harness {role.replace("-", " ")}', 'mode':'primary' if role == 'router' else 'all',
            'model':models[tier], 'system':prompts['common']+'\n'+prompts['routing' if delegate else 'leaf']+identity_guidance, 'permissions':rules}
        if role == 'verifier':
            definition['system'] += '\nExecute the assigned checks and report commands, exit codes and findings. Do not implement repairs. Shell execution can write artifacts; retain declared workspace ownership and all native approvals. This role is not a read-only sandbox.'
        agents[visible_role(role)] = definition
        agents[role] = {**definition, 'description':role.replace('-', ' '), 'hidden':True}
    for builtin in ('build','plan','general','explore'):
        agents[builtin] = {'disabled':False, 'permissions':[
            {'action':action,'resource':'*','effect':'deny'} for action in
            ('task_*','check_prepare','check_status','harness_health','large_file_*')]}
        if builtin == 'plan':
            agents[builtin]['permissions'] += [{'action':'edit','resource':'*','effect':'deny'},
                {'action':'edit','resource':'~/.opencode/plan/*','effect':'allow'}]
        if builtin in ('general','explore'):
            agents[builtin]['permissions'].append({'action':'subagent','resource':'*','effect':'deny'})
        if builtin == 'explore':
            agents[builtin]['permissions'].append({'action':'edit','resource':'*','effect':'deny'})
    permissions = [{'action':'*','resource':'*','effect':'ask'}]
    permissions += [{'action':a,'resource':'*','effect':'allow'} for a in ('read','glob','grep','edit','webfetch','codex_quota','model_status','task_contract','task_intent','task_artifact','task_dispatch_status','task_outcome','large_file_check','large_file_summary','subscription_quota')]
    for action in ('read','edit'):
        permissions += [{'action':action,'resource':p,'effect':'deny'} for p in ('*.env','*.env.*','*auth.json','*.pem','*.key')]
    for command in ('pwd','git status*','git diff*','git log*','npm test*','npm run test*','pytest*','python3 -m pytest*','go test*','gofmt *'):
        permissions.append({'action':'shell','resource':command,'effect':'allow'})
    return {'$schema':'https://opencode.ai/v2/config.json','enabled_providers':providers,'experimental':{'policies':[{'effect':'deny','action':'provider.use','resource':'*'}]+[{'effect':'allow','action':'provider.use','resource':provider} for provider in providers]},'share':'disabled','update':'disable',
        'default_agent':'harness-router','model':models['STRONG'],'permissions':permissions,'agents':agents,
        'plugins':[(package_root/'plugins/v2'/p).resolve().as_uri() for p in ('subscription-guard','model-status','task-outcomes','large-file-context')]}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--models',type=Path,required=True,help='JSON FAST/BALANCED/STRONG/MAXIMUM references from your actual catalog')
    p.add_argument('--state-dir',type=Path,default=Path(os.environ.get('HARNESS_STATE_DIR',str(Path.home()/'.local/state/opencode-usage-harness'))))
    p.add_argument('--replace',action='store_true',help='Back up and replace this generated profile explicitly')
    p.add_argument('--routing-policy',type=Path,help='Explicit reviewed candidate policy; requires separately installed/authenticated subscription plugins')
    a=p.parse_args(); routing=json.loads(a.routing_policy.read_text()) if a.routing_policy else None
    result=profile(json.loads(a.models.read_text()),routing_policy=routing)
    directory=a.state_dir.expanduser().resolve()/'config';target=directory/'opencode.json'
    replacing = target.exists()
    if replacing and not a.replace:
        p.error('profile exists; use --replace only after reviewing changes')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.exists():
        backup=target.with_name(f'opencode.backup-{time.time_ns()}.json');backup.write_bytes(target.read_bytes());backup.chmod(0o600)
    target.write_text(json.dumps(result,indent=2)+'\n');target.chmod(0o600)
    policy_path=directory/'routing-policy.json'
    if routing is not None:
        if policy_path.exists():
            policy_path.with_name(f'routing-policy.backup-{time.time_ns()}.json').write_bytes(policy_path.read_bytes())
        policy_path.write_text(json.dumps(routing,indent=2)+'\n');policy_path.chmod(0o600)
    elif policy_path.exists():
        policy_path.with_name(f'routing-policy.backup-{time.time_ns()}.json').write_bytes(policy_path.read_bytes())
        policy_path.unlink()
    financial=directory/'financial-verification.json'
    if 'openai' in result['enabled_providers'] and not financial.exists():
        financial.write_text(json.dumps({'auto_top_up_off':False,'automatic_reload_off':False,'purchased_credit_balance_ui':None,'verified_at':None},indent=2)+'\n');financial.chmod(0o600)
    requirements=[]
    if 'openai' in result['enabled_providers']: requirements.append('OpenAI OAuth/account and financial verification')
    if 'anthropic' in result['enabled_providers']: requirements.append('reviewed Claude OAuth adapter and disabled usage credits')
    print(f'Prepared {target}; no service started. Required before inference: '+ '; '.join(requirements)+'.')

if __name__=='__main__':main()

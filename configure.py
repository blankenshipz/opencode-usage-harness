#!/usr/bin/env python3
"""Prepare an isolated OpenCode V2 profile; never migrate or start a service."""
import argparse
import json
import os
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ROLES = {
    'router': ('STRONG', True, True),
    'coordinator': ('BALANCED', True, True),
    'scout': ('FAST', False, True),
    'quick-builder': ('FAST', False, False),
    'builder': ('BALANCED', False, False),
    'deep-debugger': ('STRONG', False, False),
    'architect': ('STRONG', False, True),
    'reviewer': ('STRONG', False, True),
    'maximum': ('MAXIMUM', False, False),
}

def profile(models, package_root=ROOT):
    for tier in ('FAST', 'BALANCED', 'STRONG', 'MAXIMUM'):
        if not isinstance(models.get(tier), str) or not re.fullmatch(r'openai/[A-Za-z0-9._-]+#[A-Za-z0-9_-]+', models[tier]):
            raise ValueError(f'{tier} must be an actual discovered openai/model#variant reference')
    prompts = json.loads((package_root/'config/instructions.json').read_text())
    agents = {}
    for role, (tier, delegate, readonly) in ROLES.items():
        rules = [{'action':'subagent','resource':'*','effect':'deny'},
                 {'action':'large_file_summary','resource':'*','effect':'allow' if delegate else 'deny'},
                 {'action':'large_file_allow_direct','resource':'*','effect':'deny' if readonly else 'allow'},
                 {'action':'task_dispatch','resource':'*','effect':'allow' if delegate else 'deny'}]
        if delegate:
            rules += [{'action':'subagent','resource':child,'effect':'allow'} for child in ROLES if child != 'router' and (role == 'router' or child != 'coordinator')]
        if readonly:
            rules += [{'action':a,'resource':'*','effect':'deny'} for a in ('shell','edit')]
        agents[role] = {'description':role.replace('-',' '), 'mode':'primary' if role == 'router' else 'all',
            'model':models[tier], 'system':prompts['common']+'\n'+prompts['routing' if delegate else 'leaf'], 'permissions':rules}
    for builtin in ('build','plan','general','explore'):
        agents[builtin] = {'disabled':True}
    permissions = [{'action':'*','resource':'*','effect':'ask'}]
    permissions += [{'action':a,'resource':'*','effect':'allow'} for a in ('read','glob','grep','edit','webfetch','codex_quota','model_status','task_contract','task_intent','task_artifact','task_dispatch_status','task_outcome','large_file_check','large_file_summary')]
    for action in ('read','edit'):
        permissions += [{'action':action,'resource':p,'effect':'deny'} for p in ('*.env','*.env.*','*auth.json','*.pem','*.key')]
    for command in ('pwd','git status*','git diff*','git log*','npm test*','npm run test*','pytest*','python3 -m pytest*','go test*','gofmt *'):
        permissions.append({'action':'shell','resource':command,'effect':'allow'})
    return {'$schema':'https://opencode.ai/v2/config.json','enabled_providers':['openai'],'share':'disabled','update':'disable',
        'default_agent':'router','model':models['STRONG'],'permissions':permissions,'agents':agents,
        'plugins':[(package_root/'plugins/v2'/p).resolve().as_uri() for p in ('subscription-guard','model-status','task-outcomes','large-file-context')]}

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--models',type=Path,required=True,help='JSON FAST/BALANCED/STRONG/MAXIMUM references from your actual catalog')
    p.add_argument('--state-dir',type=Path,default=Path(os.environ.get('HARNESS_STATE_DIR',str(Path.home()/'.local/state/opencode-subscription-harness'))))
    p.add_argument('--replace',action='store_true',help='Back up and replace this generated profile explicitly')
    a=p.parse_args(); result=profile(json.loads(a.models.read_text()))
    directory=a.state_dir.expanduser().resolve()/'config';target=directory/'opencode.json'
    if target.exists() and not a.replace:
        p.error('profile exists; use --replace only after reviewing changes')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.exists():
        backup=target.with_name(f'opencode.backup-{time.time_ns()}.json');backup.write_bytes(target.read_bytes());backup.chmod(0o600)
    target.write_text(json.dumps(result,indent=2)+'\n');target.chmod(0o600)
    financial=directory/'financial-verification.json'
    if not financial.exists():
        financial.write_text(json.dumps({'auto_top_up_off':False,'automatic_reload_off':False,'purchased_credit_balance_ui':None,'verified_at':None},indent=2)+'\n');financial.chmod(0o600)
    print(f'Prepared {target}; no service started. Financial verification is required before inference.')

if __name__=='__main__':main()

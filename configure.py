#!/usr/bin/env python3
"""Prepare an isolated OpenCode V2 profile; never migrate or start a service."""
import argparse
import copy
import json
import os
import re
import tempfile
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


# Delegating roles must register shared intent before their first handoff;
# a rejected handoff forces the model to regenerate its whole prompt.
INTENT_FIRST_GUIDANCE = ("\nRecommended before the first task_dispatch/subagent handoff of a taskId: call task_intent "
    "{taskId, action:'get'} for sourceMessageIDs, then task_intent {taskId, action:'set', expectedRevision:0, "
    "intent:{outcome, target, nonGoals, authorizedEffects, assumptions, checks:[{id, description, mode}], sourceMessageIDs}}. "
    "Pass its current.revision as intentRevision and the chosen check ids as checkIds in that handoff. "
    "A handoff without them still runs: the harness infers an intent from the brief (or binds the current revision "
    "and checks) and returns a warning; correct it with task_intent set.")
# Delegating roles can stop only children they dispatched themselves.
CANCEL_GUIDANCE = ("\nTo stop a child you dispatched (e.g. after a rule change), call task_dispatch_cancel "
    "{taskId, workKey, reason}; it interrupts it and releases its locks.")

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

# Shell policies (selectable with --shell-policy; persisted in config/configure-choices.json).
# Native shell permissions match each parsed command separately (cd/pushd become directory
# checks); a command's resource includes its own redirections; the last matching rule wins.
# OpenCode 2.0.30 drops redirects after && and skips bare `> f`; the task-outcomes plugin's
# raw-command shell guard covers those gaps under either policy.
ALLOWLIST_SHELL_ALLOW = ('pwd','git status*','git diff*','git log*','npm test*','npm run test*','pytest*','python3 -m pytest*','go test*','gofmt *')
# Permissive shell policy: allow by default, ask only for clearly dangerous commands.
# Lexical, not a sandbox: e.g. `bash -c '...'` contents are not parsed, so those ask.
# Plain `git push` (incl. `-u`, `origin <branch>`, `--tags`) is allowed under permissive; history-
# rewriting or deleting pushes ask. Wildcards cannot see short-flag clusters (-uf), quoted refspecs
# or git global options (git -C d push -f); plugins/v2/shell-guard.mjs classifies those and forces
# an ask, and tests/v2-shell-guard-push.test.mjs checks the two agree.
GIT_PUSH_ASK = ('git push *--force*', 'git push *--mirror*', 'git push *--delete*', 'git push *--prune*',
                'git push *--receive-pack*', 'git push *--exec*',
                'git push -f', 'git push -f *', 'git push * -f', 'git push * -f *',
                'git push -d', 'git push -d *', 'git push * -d', 'git push * -d *',
                'git push * +*', 'git push * :*', 'git push * "+*', "git push * '+*", 'git push * ":*', "git push * ':*")
# Branch-gated: plain `git add`/`git stage`/`git commit` ask here, and shell-guard.mjs downgrades
# that ask to allow when it has resolved every target repo's current branch to something other
# than main/master (feature branches). Main/master, detached or unresolvable HEADs, branch switches
# or cd tricks in the same command keep the ask; without the guard the ask stands (fail closed).
# Must match shell-guard.mjs BRANCH_GATED_PATTERNS. Amend asks on every branch (listed after, so it wins).
BRANCH_GATED_ASK = ('git add*', 'git stage*', 'git commit*')
GIT_COMMIT_ASK = ('git commit *--am*',)
GIT_BRANCH_DELETE_ASK = ('git branch -D*', 'git branch * -D*', 'git branch -d*', 'git branch * -d*', 'git branch *--d*')
_RM_RECURSIVE = ('-r', '-R', '-rf', '-fr', '-Rf', '-fR', '-rF', '-Fr', '-rfv', '-vrf', '-frv', '-rvf', '-fvr', '-vfr', '--recursive')
DANGEROUS_COMMAND_ASK = tuple(p for flag in _RM_RECURSIVE for p in (f'rm {flag} *', f'rm * {flag} *', f'rm * {flag}')) + (
    'sudo *', '* sudo *', 'doas *', 'su', 'su *',
    *GIT_PUSH_ASK, 'git reset *--hard*', 'git clean *-*f*', 'git checkout -- *', 'git checkout * -- *', 'git checkout .',
    'git checkout -f*', 'git restore *', 'git rebase*', *BRANCH_GATED_ASK, *GIT_COMMIT_ASK, 'git stash*', *GIT_BRANCH_DELETE_ASK,
    'git * --force*', 'git * -f', 'git filter-branch*', 'git update-ref -d*',
    'chmod -R*', 'chmod * -R*', 'chown -R*', 'chown * -R*',
    'sh', 'bash', 'zsh', 'dash', 'sh -*', 'bash -*', 'zsh -*', 'dash -*', 'eval *', 'xargs *rm *', 'find *-delete*',
    'dd *', 'mkfs*', 'shred *', 'kill *', 'pkill *', 'killall *')
# Wrappers run their argument as a command, so a dangerous command behind one would match only
# the wrapper's prefix (allowed by `*` under permissive). Ask for the wrapped forms too, including
# argv after `--` (check_receipt.py and similar runners) and find -exec/-ok.
_WRAPPED_DANGEROUS = ('git commit', 'git add', 'git stage', 'git branch -d', 'git branch -D', 'git reset', 'git rebase', 'git clean', 'git checkout --', 'git restore',
                      'git stash', 'git filter-branch', 'git update-ref', 'rm -r', 'rm -R', 'rm -f', 'rm --recursive', 'sudo', 'doas',
                      'kill', 'pkill', 'killall', 'dd', 'mkfs', 'shred', 'chmod -R', 'chown -R', 'sh', 'bash', 'zsh', 'dash', 'eval')
_SHELL_WRAPPERS = ('env', 'xargs', 'timeout', 'nice', 'nohup', 'command', 'time', 'stdbuf', 'setsid', 'exec', 'builtin', 'flock', 'parallel')
WRAPPED_COMMAND_ASK = tuple(dict.fromkeys(
    [f'{w} {f}{c}{t}' for w in _SHELL_WRAPPERS for c in _WRAPPED_DANGEROUS for f in ('', '* ') for t in ('', ' *')] +
    [f'* -- {c} *' for c in _WRAPPED_DANGEROUS] + [f'* -- {c}' for c in _WRAPPED_DANGEROUS] +
    [f'{w} {f}{p}' for w in _SHELL_WRAPPERS for p in GIT_PUSH_ASK for f in ('', '* ')] + [f'* -- {p}' for p in GIT_PUSH_ASK] +
    ['find *-exec*', 'find *-ok*', 'find *-execdir*', 'find *-okdir*']))
SECRET_SHELL_ASK = ('*.env*', '*auth.json*', '*.pem*', '*.key*', '*credentials*', '*secret*', '*financial-policy*', '*external-write-grants*')
DANGEROUS_SHELL_ASK = DANGEROUS_COMMAND_ASK + WRAPPED_COMMAND_ASK + SECRET_SHELL_ASK
# Committed env templates hold placeholder values, not secrets. Exceptions match the exact
# basename (any directory) and follow the secret deny/ask rules they relax (last match wins).
# Real .env, .env.local, .env.production, ... stay protected.
ENV_TEMPLATE_NAMES = ('.env.example', '.env.sample', '.env.template')
SECRET_FILE_DENY = ('*.env','*.env.*','*auth.json','*.pem','*.key','*anthropic-financial-policy.json','*external-write-grants.json')
ENV_TEMPLATE_FILE_ALLOW = tuple(p for name in ENV_TEMPLATE_NAMES for p in (name, f'*/{name}'))
# Shell resources are whole command strings: allow a template only as a space-separated word.
# These sit after the secret asks but before the dangerous-command asks, so `rm -rf .env.example`
# still asks; the shell guard re-asks when a template appears next to another secret word.
ENV_TEMPLATE_SHELL_ALLOW = tuple(p for name in ENV_TEMPLATE_NAMES
                                 for p in (f'* {name}', f'* {name} *', f'* */{name}', f'* */{name} *'))
CLAUDE_AUTH_PACKAGE = ('opencode-claude-auth', '3.0.0')

def verified_claude_auth_plugin(directory):
    """Return the resolved directory of a built opencode-claude-auth 3.0.0 plugin, else None.

    Identity check only (package name/version, directory entrypoint and built dist); the
    subscription-only patch itself is verified when the artifact is vendored (see
    docs/CLAUDE-SUBSCRIPTION.md)."""
    directory = Path(directory).expanduser()
    try:
        if directory.is_symlink() or not directory.is_dir():
            return None
        package = json.loads((directory/'package.json').read_text())
        if (package.get('name'), package.get('version')) != CLAUDE_AUTH_PACKAGE:
            return None
        if not (directory/'index.mjs').is_file() or not (directory/'dist'/'index.js').is_file():
            return None
    except (OSError, ValueError, AttributeError):
        return None
    return directory.resolve()

def claude_auth_candidates(package_root=ROOT):
    root = Path(package_root).resolve()
    # Release-local vendoring (as hand-installed) first, then <prefix>/vendor/claude-auth, which
    # stays outside the hash-pinned release inventory.
    return [root/'plugins/v2/claude-auth', root.parent.parent/'vendor'/'claude-auth']

def find_claude_auth_plugin(package_root=ROOT):
    for candidate in claude_auth_candidates(package_root):
        found = verified_claude_auth_plugin(candidate)
        if found is not None:
            return found
    return None

def previous_claude_auth_plugin(profile_path):
    """Carry forward a still-valid claude-auth entry from the profile being replaced."""
    from urllib.parse import unquote, urlparse
    try:
        plugins = json.loads(Path(profile_path).read_text()).get('plugins') or []
    except (OSError, ValueError, AttributeError):
        return None
    for uri in plugins if isinstance(plugins, list) else []:
        if isinstance(uri, str) and uri.startswith('file://'):
            path = Path(unquote(urlparse(uri).path))
            if path.name == 'claude-auth':
                found = verified_claude_auth_plugin(path)
                if found is not None:
                    return found
    return None

SHELL_POLICIES = ('allowlist', 'permissive')
DEFAULT_SHELL_POLICY = 'allowlist'
BUILDER_FILE_WRITE_GUIDANCE = ('\nWrite files with the edit/write tool, not shell heredocs, echo or other redirection; '
                               'shell output already includes stderr, so omit 2>&1 and > redirects.')
READONLY_IDENTITY_GUIDANCE = ('\nYou have no shell. For the working directory, git toplevel, branch, HEAD and dirty state, '
                              'call repo_identity instead of asking for pwd or git commands.')

def shell_rules(shell_policy):
    if shell_policy == 'allowlist':
        return [{'action':'shell','resource':command,'effect':'allow'} for command in ALLOWLIST_SHELL_ALLOW]
    if shell_policy == 'permissive':
        return ([{'action':'shell','resource':'*','effect':'allow'}] +
                [{'action':'shell','resource':p,'effect':'ask'} for p in SECRET_SHELL_ASK] +
                [{'action':'shell','resource':p,'effect':'allow'} for p in ENV_TEMPLATE_SHELL_ALLOW] +
                [{'action':'shell','resource':command,'effect':'ask'} for command in DANGEROUS_COMMAND_ASK + WRAPPED_COMMAND_ASK])
    raise ValueError(f'shell_policy must be one of {", ".join(SHELL_POLICIES)}')

# Opt-in scratch space outside the workspace (--allow-tmp-scratch; persisted). Only the native
# external_directory gate is relaxed for /tmp/*; read/edit secret denials and shell rules still apply.
TMP_SCRATCH_RULES = ({'action':'external_directory','resource':'/tmp/*','effect':'allow'},)

# Always on: agents must read the check receipts the harness writes under its own state dir, which
# usually lies outside the project. Only <resolved state dir>/check-receipts/* is relaxed for the
# external_directory gate; read/edit secret denials and shell rules still apply.
def default_state_dir():
    return Path(os.environ.get('HARNESS_STATE_DIR',str(Path.home()/'.local/state/opencode-usage-harness'))).expanduser().resolve()

def check_receipts_rule(state_dir):
    return {'action':'external_directory','resource':str(Path(state_dir).expanduser().resolve()/'check-receipts')+'/*','effect':'allow'}

def profile(models, package_root=ROOT, routing_policy=None, shell_policy=DEFAULT_SHELL_POLICY, claude_auth_plugin=None, tmp_scratch=False, state_dir=None):
    shell_permissions = shell_rules(shell_policy)
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
                 {'action':'task_dispatch','resource':'*','effect':'allow' if delegate else 'deny'},
                 {'action':'task_dispatch_cancel','resource':'*','effect':'allow' if delegate else 'deny'}]
        if delegate:
            children = [child for child in ROLES if child != 'router' and (role == 'router' or child != 'coordinator')]
            rules += [{'action':'subagent','resource':child_id,'effect':'allow'}
                      for child in children for child_id in (child, visible_role(child))]
        if readonly:
            rules += [{'action':a,'resource':'*','effect':'deny'} for a in ('shell','edit')]
        for protected in ('*anthropic-financial-policy.json','*external-write-grants.json'):
            rules.append({'action':'edit','resource':protected,'effect':'deny'})
        if role == 'verifier':
            rules.append({'action':'edit','resource':'*','effect':'deny'})
            # Verification may need fresh fixtures/scripts, not production repairs.
            # Native permissions are lexical; this is not a filesystem sandbox.
            rules += [{'action':'edit','resource':p,'effect':'allow'}
                      for p in ('.artifacts/*', '*/.artifacts/*')]
            rules += [{'action':'edit','resource':p,'effect':'deny'} for p in SECRET_FILE_DENY]
            # Env templates are not secrets, but the verifier still writes only under .artifacts.
            rules += [{'action':'edit','resource':f'{root}.artifacts/{sub}{name}','effect':'allow'}
                      for root in ('', '*/') for sub in ('', '*/') for name in ENV_TEMPLATE_NAMES]

        identity_guidance = ('\nUse visible harness-* IDs for new handoffs. When continuing an existing worker, '
                             'pass its exact stored agent ID and sessionID; never rename or adopt it.')
        definition = {'description':f'harness {role.replace("-", " ")}', 'mode':'primary' if role == 'router' else 'all',
            'model':models[tier], 'system':prompts['common']+'\n'+prompts['routing' if delegate else 'leaf']+identity_guidance+(INTENT_FIRST_GUIDANCE+CANCEL_GUIDANCE if delegate else ''), 'permissions':rules}
        if 'builder' in role:
            definition['system'] += BUILDER_FILE_WRITE_GUIDANCE
        if readonly:
            definition['system'] += READONLY_IDENTITY_GUIDANCE
        if role == 'verifier':
            definition['system'] += '\nExecute the assigned checks and report commands, exit codes and findings. Do not implement production repairs. Create verification scripts and fixtures only in the explicitly assigned .artifacts directory; reserve that directory in writePaths before writing. Never use artifact paths or symlinks to evade a production edit denial. Shell execution can write artifacts; retain declared workspace ownership and all native approvals. This role is not a read-only sandbox.'
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
    permissions += [{'action':a,'resource':'*','effect':'allow'} for a in ('read','glob','grep','edit','webfetch','codex_quota','model_status','task_contract','task_intent','task_artifact','task_dispatch_status','task_outcome','large_file_check','large_file_summary','subscription_quota','repo_identity')]
    for action in ('read','edit'):
        permissions += [{'action':action,'resource':p,'effect':'deny'} for p in SECRET_FILE_DENY]
        permissions += [{'action':action,'resource':p,'effect':'allow'} for p in ENV_TEMPLATE_FILE_ALLOW]
    permissions += shell_permissions
    permissions.append(check_receipts_rule(default_state_dir() if state_dir is None else state_dir))
    if tmp_scratch:
        permissions += [dict(rule) for rule in TMP_SCRATCH_RULES]
    return {'$schema':'https://opencode.ai/v2/config.json','enabled_providers':providers,'experimental':{'policies':[{'effect':'deny','action':'provider.use','resource':'*'}]+[{'effect':'allow','action':'provider.use','resource':provider} for provider in providers]},'share':'disabled','update':'disable',
        'default_agent':'harness-router','model':models['STRONG'],'permissions':permissions,'agents':agents,
        'plugins':[(package_root/'plugins/v2'/p).resolve().as_uri() for p in ('subscription-guard','model-status','task-outcomes','large-file-context')]
            # The Claude OAuth adapter is loaded only when Anthropic is enabled and a verified build exists.
            + ([Path(claude_auth_plugin).resolve().as_uri()] if claude_auth_plugin is not None and 'anthropic' in providers else [])}

# Absolute context-token trigger for high pressure and compaction eligibility
# (persisted as compaction_tokens; read by plugins/v2/work-checkpoint.mjs). The
# effective trigger is min(this, 80% of a known model window). The
# HARNESS_COMPACTION_TOKENS environment variable overrides the persisted value.
DEFAULT_COMPACTION_TOKENS = 120000
MIN_COMPACTION_TOKENS, MAX_COMPACTION_TOKENS = 1000, 10000000

def valid_compaction_tokens(value):
    return isinstance(value,int) and not isinstance(value,bool) and MIN_COMPACTION_TOKENS <= value <= MAX_COMPACTION_TOKENS

def compaction_tokens_arg(text):
    try: value=int(text)
    except ValueError: raise argparse.ArgumentTypeError(f'invalid integer {text!r}')
    if not valid_compaction_tokens(value):
        raise argparse.ArgumentTypeError(f'must be between {MIN_COMPACTION_TOKENS} and {MAX_COMPACTION_TOKENS}')
    return value

def load_choices(path):
    try:
        value=json.loads(path.read_text())
    except FileNotFoundError:
        return {}
    if not isinstance(value,dict) or value.get('shell_policy',DEFAULT_SHELL_POLICY) not in SHELL_POLICIES or not isinstance(value.get('tmp_scratch',False),bool) \
            or not valid_compaction_tokens(value.get('compaction_tokens',DEFAULT_COMPACTION_TOKENS)):
        raise SystemExit(f'{path}: invalid persisted configure choices')
    return value

def atomic_write_text(target,text):
    """Write via a private temp file + rename so a watching runtime never reads a partial profile."""
    fd,temporary=tempfile.mkstemp(dir=target.parent,prefix=f'.{target.name}.',suffix='.tmp')
    try:
        with os.fdopen(fd,'w') as handle:
            handle.write(text);handle.flush();os.fsync(handle.fileno())
        os.chmod(temporary,0o600);os.replace(temporary,target)
    except BaseException:
        try: os.unlink(temporary)
        except FileNotFoundError: pass
        raise

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--models',type=Path,required=True,help='JSON FAST/BALANCED/STRONG/MAXIMUM references from your actual catalog')
    p.add_argument('--state-dir',type=Path,default=Path(os.environ.get('HARNESS_STATE_DIR',str(Path.home()/'.local/state/opencode-usage-harness'))))
    p.add_argument('--replace',action='store_true',help='Back up and replace this generated profile explicitly')
    p.add_argument('--routing-policy',type=Path,help='Explicit reviewed candidate policy; requires separately installed/authenticated subscription plugins')
    p.add_argument('--shell-policy',choices=SHELL_POLICIES,help=f'Shell permission policy: allowlist (ask for unlisted commands) or permissive (allow all except dangerous commands). Defaults to the previously persisted choice, else {DEFAULT_SHELL_POLICY}')
    p.add_argument('--claude-auth-plugin',type=Path,help='Built, patched opencode-claude-auth 3.0.0 plugin directory (persisted). Default: previously persisted path, else <release>/plugins/v2/claude-auth, else <prefix>/vendor/claude-auth')
    p.add_argument('--allow-tmp-scratch',action=argparse.BooleanOptionalAction,default=None,help='Allow agents to use /tmp/* outside the workspace without an external_directory prompt (persisted; --no-allow-tmp-scratch turns it off). Default: previously persisted choice, else off')
    p.add_argument('--compaction-tokens',type=compaction_tokens_arg,default=None,metavar='N',help=f'Absolute context tokens that mark a session high-pressure and eligible for compaction, even when a larger model window is known (effective trigger: min(N, 80%% of the window)); persisted. HARNESS_COMPACTION_TOKENS overrides it at runtime. Default: previously persisted choice, else {DEFAULT_COMPACTION_TOKENS}')
    a=p.parse_args(); routing=json.loads(a.routing_policy.read_text()) if a.routing_policy else None
    state_dir=a.state_dir.expanduser().resolve();directory=state_dir/'config';target=directory/'opencode.json'
    choices_path=directory/'configure-choices.json'
    choices=load_choices(choices_path)
    shell_policy=a.shell_policy or choices.get('shell_policy') or DEFAULT_SHELL_POLICY
    tmp_scratch=a.allow_tmp_scratch if a.allow_tmp_scratch is not None else choices.get('tmp_scratch',False)
    compaction_tokens=a.compaction_tokens if a.compaction_tokens is not None else choices.get('compaction_tokens',DEFAULT_COMPACTION_TOKENS)
    claude_auth=None
    if a.claude_auth_plugin is not None:
        claude_auth=verified_claude_auth_plugin(a.claude_auth_plugin)
        if claude_auth is None:
            p.error(f'--claude-auth-plugin {a.claude_auth_plugin}: not a built opencode-claude-auth 3.0.0 plugin directory')
    elif isinstance(choices.get('claude_auth_plugin'),str):
        claude_auth=verified_claude_auth_plugin(choices['claude_auth_plugin'])
        if claude_auth is None:
            p.error(f'persisted claude_auth_plugin {choices["claude_auth_plugin"]} is missing or invalid; pass --claude-auth-plugin')
    else:
        claude_auth=find_claude_auth_plugin() or previous_claude_auth_plugin(target)
    result=profile(json.loads(a.models.read_text()),routing_policy=routing,shell_policy=shell_policy,claude_auth_plugin=claude_auth,tmp_scratch=tmp_scratch,state_dir=state_dir)
    replacing = target.exists()
    if replacing and not a.replace:
        p.error('profile exists; use --replace only after reviewing changes')
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    if target.exists():
        backup=target.with_name(f'opencode.backup-{time.time_ns()}.json');backup.write_bytes(target.read_bytes());backup.chmod(0o600)
    atomic_write_text(target,json.dumps(result,indent=2)+'\n')
    new_choices={**choices,'shell_policy':shell_policy,'tmp_scratch':tmp_scratch}
    if a.compaction_tokens is not None or 'compaction_tokens' in choices: new_choices['compaction_tokens']=compaction_tokens
    if a.claude_auth_plugin is not None: new_choices['claude_auth_plugin']=str(claude_auth)
    atomic_write_text(choices_path,json.dumps(new_choices,indent=2)+'\n')
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
    if 'anthropic' in result['enabled_providers']: requirements.append('reviewed Claude OAuth adapter and disabled usage credits or explicit local app-managed-credit policy')
    print(f'Shell policy: {shell_policy}.')
    print(f'/tmp scratch (external_directory /tmp/*): {"allowed" if tmp_scratch else "ask"}.')
    print(f'Check receipts (external_directory {state_dir}/check-receipts/*): allowed.')
    print(f'Compaction token threshold: {compaction_tokens} (or 80% of a smaller known window).')
    if 'anthropic' in result['enabled_providers']:
        if claude_auth is not None: print(f'Claude auth plugin: {claude_auth}.')
        else: print('WARNING: Anthropic is enabled but no built opencode-claude-auth 3.0.0 plugin was found; '
                    'vendor it (docs/CLAUDE-SUBSCRIPTION.md) and rerun with --claude-auth-plugin DIR.')
    print(f'Prepared {target}; no service started. Required before inference: '+ '; '.join(requirements)+'.')

if __name__=='__main__':main()

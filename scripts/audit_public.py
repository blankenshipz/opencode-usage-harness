#!/usr/bin/env python3
"""Bounded source-release hygiene check, not a comprehensive secret detector."""
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ALLOWED={'VERSION','LICENSE','NOTICE','README.md','SECURITY.md','CHANGELOG.md','CONTRIBUTING.md',
         '.gitignore','package.json','install.py','configure.py','plugins','config','src','bin','tests','scripts','docs','compat','.github'}
patterns=[re.compile(r'/Users/[a-zA-Z][^/\s"\']+/'),re.compile(r'192\.168\.\d+\.\d+'),
          re.compile(r'\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_\-]{20,}'),
          re.compile('-----BEGIN '+r'(?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]

def audit():
    errors=[]
    for p in ROOT.rglob('*'):
        rel=p.relative_to(ROOT)
        if any(x in {'.git','__pycache__'} for x in rel.parts):continue
        if p.is_symlink():errors.append(f'{rel}: symlink not allowed');continue
        if p.is_dir():continue
        if rel.parts[0] not in ALLOWED:errors.append(f'{rel}: unexpected release path')
        if p.name in {'auth.json','financial-verification.json','.env'} or p.suffix in {'.db','.sqlite','.log','.jsonl','.pem','.key','.pyc'}:
            errors.append(f'{rel}: private/generated file type')
        try:text=p.read_text()
        except UnicodeError:errors.append(f'{rel}: binary file');continue
        if any(pattern.search(text) for pattern in patterns):errors.append(f'{rel}: potential private content')
    for e in errors:print(e)
    if not errors:print('Public source hygiene checks passed. Manual review is still required.')
    return bool(errors)

if __name__=='__main__':raise SystemExit(audit())

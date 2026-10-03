#!/usr/bin/env python3
"""Create a checksum-bearing source archive from an existing reviewed Git tag."""
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tag',required=True)
    p.add_argument('--output-dir',type=Path,required=True)
    a=p.parse_args()
    if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?',a.tag):p.error('expected a vX.Y.Z release tag')
    def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT,text=True).strip()
    if git('status','--porcelain'):p.error('working tree must be clean before packaging')
    ref='refs/tags/'+a.tag
    if git('rev-parse',ref+'^{commit}')!=git('rev-parse','HEAD'):p.error('check out the exact release tag first')
    version=git('show',ref+':VERSION')
    if a.tag!='v'+version or json.loads(git('show',ref+':package.json'))['version']!=version:p.error('tag, VERSION and package.json disagree')
    subprocess.run(['python3',str(ROOT/'scripts/audit_public.py')],check=True,cwd=ROOT)
    out=a.output_dir.expanduser().resolve();out.mkdir(parents=True,exist_ok=True)
    name=f'opencode-usage-harness-{version}'
    archive=out/(name+'.tar.gz');sums=out/'SHA256SUMS'
    if archive.exists() or sums.exists():p.error('refusing to overwrite release artifacts')
    subprocess.run(['git','archive','--format=tar.gz','--prefix='+name+'/', '--output='+str(archive),ref],cwd=ROOT,check=True)
    sums.write_text(hashlib.sha256(archive.read_bytes()).hexdigest()+'  '+archive.name+'\n')
    print(f'Created {archive} and {sums}; nothing uploaded.')

if __name__=='__main__':main()

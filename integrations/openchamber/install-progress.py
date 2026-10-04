#!/usr/bin/env python3
"""Install the opt-in reconnect adapter into a local OpenChamber 2.0.3 tree.
Backs up proxy.js; never starts/stops a service or changes authentication.
"""
import argparse,json,time
from pathlib import Path

def patch(source, module_uri, directory):
    marker='  // Generic proxy for non-SSE OpenCode API routes.'
    if 'harness-progress-adapter-v1' in source:
        raise ValueError('adapter already installed; restore the saved proxy before upgrading')
    if source.count(marker)!=1 or 'const fetchSessionListPayload = async' not in source:
        raise ValueError('unsupported proxy layout')
    header=f'import {{ createProgressStore, hydrateProgress }} from {json.dumps(module_uri)};\n'
    block='''  // harness-progress-adapter-v1: existing auth/directory guards remain upstream.
  const harnessProgressStore = createProgressStore(DIRECTORY);
  app.get(['/api/session/:sessionID/message', '/api/session/:sessionID/message/:messageID'], async (req, res, next) => {
    try {
      const result = await fetchSessionListPayload(await getRequestUpstreamPath(req), { req, timeoutMs: 30000 });
      if (!result.upstream.ok || !result.isJson || result.parseError) return next();
      const hydrated = await hydrateProgress(result.payload, req.params.sessionID, harnessProgressStore);
      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.removeHeader('content-length'); res.removeHeader('etag');
      res.setHeader('Cache-Control', 'no-store');
      res.json(hydrated);
    } catch { next(); }
  });

'''.replace('DIRECTORY',json.dumps(str(directory)))
    return header+source.replace(marker,block+marker)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--web-root',type=Path,required=True);p.add_argument('--snapshot-dir',type=Path,required=True);a=p.parse_args()
    root=a.web_root.resolve();package=json.loads((root/'package.json').read_text())
    if package.get('version')!='2.0.3':p.error('only the inspected OpenChamber 2.0.3 layout is supported')
    target=root/'server/lib/opencode/proxy.js';source=target.read_text()
    module=(Path(__file__).resolve().parents[2]/'plugins/v2/progress-snapshots.mjs').as_uri()
    result=patch(source,module,a.snapshot_dir.resolve());backup=target.with_name(f'proxy.js.harness-backup-{time.time_ns()}');backup.write_text(source);backup.chmod(0o600)
    tmp=target.with_suffix('.tmp');tmp.write_text(result);tmp.chmod(target.stat().st_mode&0o777);tmp.replace(target)
    print('Adapter installed; backup:',backup)
    print('Restart only OpenChamber when ready; keep its attached OpenCode service running.')
if __name__=='__main__':main()

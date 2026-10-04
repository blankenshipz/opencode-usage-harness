#!/usr/bin/env python3
"""Install the opt-in reconnect adapter into a local OpenChamber 2.0.3 tree.
Backs up proxy.js; never starts/stops a service or changes authentication.
"""
import argparse,json,time
from pathlib import Path

def patch(source, module_uri, directory):
    marker='  // Generic proxy for non-SSE OpenCode API routes.'
    if 'harness-progress-adapter-v' in source:
        raise ValueError('adapter already installed; use --upgrade to replace a supported previous adapter')
    if source.count(marker)!=1 or 'const fetchSessionListPayload = async' not in source:
        raise ValueError('unsupported proxy layout')
    header=f'import {{ createProgressStore, hydrateProgress }} from {json.dumps(module_uri)};\n'
    header+=f'import {{ createMilestoneStore, overlayMilestones, milestoneSse }} from {json.dumps(module_uri.replace("progress-snapshots.mjs","milestones.mjs"))};\n'
    block='''  // harness-progress-adapter-v2: existing auth/directory guards remain upstream.
  const harnessProgressStore = createProgressStore(DIRECTORY);
  const harnessMilestoneStore = createMilestoneStore({directory: MILESTONES});
  app.get(['/api/session/:sessionID/message', '/api/session/:sessionID/message/:messageID'], async (req, res, next) => {
    try {
      const result = await fetchSessionListPayload(await getRequestUpstreamPath(req), { req, timeoutMs: 30000 });
      if (!result.upstream.ok || !result.isJson || result.parseError) return next();
      const hydrated = await hydrateProgress(result.payload, req.params.sessionID, harnessProgressStore);
      const query = new URL(req.originalUrl, 'http://localhost').searchParams;
      if (!req.params.messageID) await overlayMilestones(hydrated, req.params.sessionID, harnessMilestoneStore, {cursor: query.has('cursor'), order: query.get('order') || 'desc', filtered: query.has('type')});
      res.status(result.upstream.status);
      applyForwardProxyResponseHeaders(result.upstream.headers, res);
      res.removeHeader('content-length'); res.removeHeader('etag');
      res.setHeader('Cache-Control', 'no-store');
      res.json(hydrated);
    } catch { next(); }
  });

'''.replace('DIRECTORY',json.dumps(str(directory))).replace('MILESTONES',json.dumps(str(directory.parent/'milestones')))
    heartbeat="      const scheduleHeartbeat = () => {"
    tick="          const canContinue = await enqueueSseWrite(':heartbeat\\n\\n');"
    if source.count(heartbeat)!=1 or source.count(tick)!=1:
        raise ValueError('unsupported SSE layout')
    setup="""      // harness-milestone-sse-v1: UI-only events, never OpenCode inbox input.
      const milestoneSent = new Set();
      const milestoneSince = Date.now();
      let milestoneHeader = req.get('x-opencode-directory') || '';
      if (req.get('x-opencode-directory-encoding') === 'uri') {
        try { milestoneHeader = decodeURIComponent(milestoneHeader); } catch { /* Match native raw-header fallback. */ }
      }
      const milestoneDirectory = new URL(requestUrl, 'http://localhost').searchParams.get('directory') || milestoneHeader || null;
      const flushMilestones = async () => {
        try {
          for (const item of await harnessMilestoneStore.feed(milestoneSince, milestoneDirectory)) {
            if (milestoneSent.has(item.message.id)) continue;
            if (!sseBoundary.isAtBoundary()) return;
            if (!await enqueueSseWrite(milestoneSse(item))) return;
            milestoneSent.add(item.message.id);
            if (milestoneSent.size > 1000) milestoneSent.delete(milestoneSent.values().next().value);
          }
        } catch { /* UI reporting cannot break the upstream stream. */ }
      };

"""
    source=source.replace(heartbeat,setup+heartbeat).replace(tick,"          await flushMilestones();\n          if (!sseBoundary.isAtBoundary()) { scheduleHeartbeat(); return; }\n"+tick)
    return header+source.replace(marker,block+marker)

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--web-root',type=Path,required=True);p.add_argument('--snapshot-dir',type=Path,required=True);p.add_argument('--upgrade',action='store_true');a=p.parse_args()
    root=a.web_root.resolve();package=json.loads((root/'package.json').read_text())
    if package.get('version')!='2.0.3':p.error('only the inspected OpenChamber 2.0.3 layout is supported')
    target=root/'server/lib/opencode/proxy.js';source=target.read_text();original=source
    if a.upgrade and 'harness-progress-adapter-v' in source:
        if 'harness-progress-adapter-v1:' not in source: p.error('restore the original backup before replacing an unknown adapter version')
        begin=source.index('  // harness-progress-adapter-v1:');end=source.index('  // Generic proxy for non-SSE OpenCode API routes.',begin)
        source=source[:begin]+source[end:]
        lines=source.splitlines(True);lines=[line for line in lines if not line.startswith('import { createProgressStore, hydrateProgress } from ')]
        source=''.join(lines)
    module=(Path(__file__).resolve().parents[2]/'plugins/v2/progress-snapshots.mjs').as_uri()
    result=patch(source,module,a.snapshot_dir.resolve());backup=target.with_name(f'proxy.js.harness-backup-{time.time_ns()}');backup.write_text(original);backup.chmod(0o600)
    tmp=target.with_suffix('.tmp');tmp.write_text(result);tmp.chmod(target.stat().st_mode&0o777);tmp.replace(target)
    print('Adapter installed; backup:',backup)
    print('Restart only OpenChamber when ready; keep its attached OpenCode service running.')
if __name__=='__main__':main()

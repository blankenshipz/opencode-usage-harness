// Keep the existing parent call alive through native compaction. This is a
// bounded read-only wait, never a timer that wakes or reruns either session.
export async function waitForCompactionIdle(session, sessionID, { timeoutMs = 180000 } = {}) {
  if (typeof session?.wait !== 'function') return 'unavailable';
  let timer;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => session.wait({ sessionID }, { signal: controller.signal }))
        .then(() => 'idle', () => 'unavailable'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

import path from 'node:path';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const activeDescendant = (sessions, id, ancestor) => {
  const byID=new Map(sessions.map(session=>[session.id,session])); const seen=new Set();
  for (let current=byID.get(id); current?.parentID && !seen.has(current.id); current=byID.get(current.parentID)) {
    if (current.parentID===ancestor) return true; seen.add(current.id);
  }
  return false;
};
const containsPath = (root, item) => root === path.parse(root).root || item===root || item.startsWith(`${root}${path.sep}`);
export const writerPathsOverlap = (left, right) => left.some(a => right.some(b => containsPath(a,b) || containsPath(b,a)));
const activeLease = (lease, sessions, isPidLive) => {
  if (lease.childID && sessions.some(session => session.active && (session.id===lease.childID || activeDescendant(sessions,session.id,lease.childID)))) return true;
  // A missing child identity is never treated as proof that the provisional
  // write is harmless; a native accept can precede a progress identity.
  if (!lease.childID) return true;
  if (lease.inFlight) return !Number.isInteger(lease.ownerPid) || isPidLive(lease.ownerPid);
  return false;
};
export function pruneWriterLeases(state, { sessions=[], isPidLive=pid => { try { process.kill(pid,0); return true; } catch (error) { return error.code !== 'ESRCH'; } } } = {}) {
  if (!isObject(state)) throw new Error('task-dispatch: global writer lease state is invalid');
  if (state.leases !== undefined && !Array.isArray(state.leases)) throw new Error('task-dispatch: global writer lease state is invalid');
  const before=state.leases ?? [];
  if (before.some(lease => !isObject(lease) || !Array.isArray(lease.paths))) throw new Error('task-dispatch: global writer lease state is invalid');
  state.leases=before.filter(lease => activeLease(lease,sessions,isPidLive));
  return before.length!==state.leases.length;
}
export function assertWriterLeaseAvailable(state, candidate, { delegatedOwner } = {}) {
  if (!isObject(candidate) || !candidate.token || !candidate.workspace || !candidate.key || !Array.isArray(candidate.paths) || !candidate.paths.length)
    throw new Error('task-dispatch: invalid global writer lease');
  for (const lease of state.leases ?? []) {
    if (lease.token===candidate.token || (lease.workspace===candidate.workspace && lease.key===candidate.key) || delegatedOwner?.(lease,candidate)) continue;
    if (writerPathsOverlap(lease.paths,candidate.paths)) throw new Error(`task-dispatch: global overlapping writer lease owned by ${lease.childID ?? lease.key}; wait for its active owner`);
  }
}
export function reserveWriterLease(state, candidate, options) {
  pruneWriterLeases(state, options);
  assertWriterLeaseAvailable(state,candidate,options);
  (state.leases ??= []).push({...candidate,inFlight:true,ownerPid:candidate.ownerPid ?? process.pid});
}
export function finishWriterLease(state, token, patch = {}) {
  const lease=(state.leases ?? []).find(item=>item.token===token);
  if (!lease) throw new Error('task-dispatch: global writer lease changed unexpectedly');
  Object.assign(lease,patch);
  if (!Object.hasOwn(patch,'inFlight')) lease.inFlight=false;
  return lease;
}

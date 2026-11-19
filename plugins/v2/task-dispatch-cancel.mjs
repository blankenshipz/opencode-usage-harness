// Explicit parent cancellation of a child this exact session dispatched.
//
// Only the recorded dispatcher (record.parentID, which is also the native
// parent) may cancel. Grandchildren are refused unless the caller is their own
// recorded dispatcher; other roots never match. The child and its active
// descendants are interrupted through the native session.interrupt API
// (resume:false so queued input cannot restart it), their pending permission
// asks are rejected without feedback (a plain rejection ends the step instead of
// handing the model an error to work around), and only after a successful
// interrupt is the ownership record marked cancelled and its writer leases
// released. Native calls run outside the registry locks; the commit revalidates
// the exact admission identity under global-before-workspace lock ordering.
import { lineage, descendant } from './dispatch-registry.mjs';

export const CANCEL_REASON_LIMIT = 500;
const listData = value => Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
const text = (value, name, limit = 240) => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\0]/.test(value))
    throw new Error(`task-dispatch: ${name} must be a non-empty string of at most ${limit} characters`);
  return value;
};
export const cancelInputSchema = { type:'object', additionalProperties:false, properties:{
  taskId:{type:'string',minLength:1,maxLength:128}, workKey:{type:'string',minLength:1,maxLength:240},
  sessionID:{type:'string',minLength:1,maxLength:240}, reason:{type:'string',minLength:1,maxLength:CANCEL_REASON_LIMIT} },
  required:['taskId','reason'] };
const activeTree = (sessions, childID) => sessions.filter(s => s.active && (s.id === childID || descendant(sessions, s.id, childID)));

export function createDispatchCanceller({ registry, globalRegistry, workspace, canonicalWorkspace, loadSessions, ctx, now = Date.now }) {
  const resolve = (state, sessions, input, callerID) => {
    const rootID = lineage(sessions, callerID);
    if (sessions.find(s => s.id === callerID)?.canonicalSessionID || sessions.find(s => s.id === rootID)?.canonicalSessionID)
      throw new Error('task-dispatch: historical transcripts cannot cancel children');
    const matches = state.records.filter(r => r.rootID === rootID && r.taskId === input.taskId &&
      (!input.workKey || r.workKey === input.workKey) && (!input.sessionID || r.childID === input.sessionID));
    if (!matches.length) throw new Error('task-dispatch: cancel refused: no dispatch record in this task tree matches taskId/workKey/sessionID');
    if (matches.length > 1) throw new Error('task-dispatch: cancel is ambiguous; name the exact workKey or sessionID');
    const record = matches[0];
    if (record.parentID !== callerID) throw new Error('task-dispatch: cancel refused: caller is not the recorded dispatcher of this child; ask its dispatcher');
    const child = record.childID ? sessions.find(s => s.id === record.childID) : undefined;
    if (record.childID && (!child || child.parentID !== callerID)) throw new Error('task-dispatch: cancel refused: child is not a native child of the caller');
    return { record, child, rootID };
  };
  const permission = () => ctx?.permission;
  const pendingRequests = async sessionID => {
    try { return listData(await permission().list({ sessionID })).filter(r => r?.id); } catch { return []; }
  };
  const rejectPending = async (ids, rejected, failed) => {
    if (typeof permission()?.list !== 'function' || typeof permission()?.reply !== 'function') return false;
    for (const sessionID of ids) for (const request of await pendingRequests(sessionID)) {
      if (rejected.has(request.id) || failed.has(request.id)) continue;
      try { await permission().reply({ sessionID, requestID: request.id, decision: 'reject' }); rejected.add(request.id); }
      catch { failed.add(request.id); } // already answered elsewhere or gone with the interrupted step
    }
    return true;
  };

  return async (input, context) => {
    text(input.taskId, 'taskId', 128); text(input.reason, 'reason', CANCEL_REASON_LIMIT);
    if (input.workKey !== undefined) text(input.workKey, 'workKey');
    if (input.sessionID !== undefined) text(input.sessionID, 'sessionID');
    if (input.workKey === undefined && input.sessionID === undefined) throw new Error('task-dispatch: cancel requires workKey and/or sessionID');
    const callerID = context?.sessionID;
    if (!callerID) throw new Error('task-dispatch: caller session is unavailable');

    // Phase 1: validate ownership and decide whether anything is still running.
    const plan = await registry(workspace, async state => {
      const sessions = await loadSessions();
      const { record, child } = resolve(state, sessions, input, callerID);
      const identity = { taskId:record.taskId, workKey:record.workKey, sessionID:record.childID, generation:record.admissionGeneration };
      if (record.state === 'cancelled' && record.cancellation?.generation === record.admissionGeneration)
        return { done:{ ...identity, status:'already_cancelled', cancellation:record.cancellation, releasedLocks:[], pendingPermissionsRejected:0 } };
      if (!record.childID) {
        if (record.inFlight) throw new Error('task-dispatch: admission is in flight before a child exists; retry cancel once task_dispatch_status shows its sessionID');
        return { done:{ ...identity, status:'not_started', recordedState:record.state, releasedLocks:[], pendingPermissionsRejected:0 } };
      }
      const tree = activeTree(sessions, record.childID);
      if (!tree.length && !record.inFlight)
        return { done:{ ...identity, status:'already_finished', recordedState:record.state, releasedLocks:[], pendingPermissionsRejected:0,
          note:'The child is idle; an inactive child holds no admission lock. Collect or reconcile its result instead.' } };
      // Inactive descendants can still hold pending asks from a stopped step.
      const subtree = sessions.filter(s => s.id === record.childID || descendant(sessions, s.id, record.childID)).map(s => s.id);
      return { identity, key:record.key, generation:record.admissionGeneration, childID:record.childID, priorState:record.state,
        targets:[record.childID, ...tree.map(s => s.id).filter(id => id !== record.childID)], subtree };
    });
    if (plan.done) return { content:JSON.stringify(plan.done), metadata:{ sessionID:plan.done.sessionID, status:plan.done.status } };
    const session = ctx?.session;
    if (typeof session?.interrupt !== 'function') throw new Error('task-dispatch: native session.interrupt is unavailable; ownership is retained');

    // Phase 2: native effects outside the registry locks (interrupt may wait on hooks that take them).
    const rejected = new Set(), failedReplies = new Set();
    const permissionsSupported = await rejectPending(plan.subtree, rejected, failedReplies);
    const interrupted = [], interruptFailures = [];
    for (const sessionID of plan.targets) {
      try { await session.interrupt({ sessionID, resume:false }); interrupted.push(sessionID); }
      catch (error) {
        if (sessionID === plan.childID) throw new Error(`task-dispatch: native interrupt of ${sessionID} failed (${String(error?.message ?? error).slice(0, 200)}); ownership is retained`);
        interruptFailures.push(sessionID);
      }
    }
    // Sweep asks raised between the first rejection pass and the interrupt.
    if (permissionsSupported) await rejectPending(plan.subtree, rejected, failedReplies);

    // Phase 3: commit, revalidating the exact admission identity.
    return globalRegistry('all-writers', async (globalState, saveGlobal) => registry(workspace, async (state, save) => {
      const sessions = await loadSessions();
      const { record } = resolve(state, sessions, input, callerID);
      if (record.key !== plan.key || record.childID !== plan.childID) throw new Error('task-dispatch: ownership changed during cancellation; inspect task_dispatch_status');
      if (record.state === 'cancelled' && record.cancellation?.generation === record.admissionGeneration)
        return { content:JSON.stringify({ ...plan.identity, status:'already_cancelled', cancellation:record.cancellation, releasedLocks:[], pendingPermissionsRejected:rejected.size }) };
      if (record.admissionGeneration !== plan.generation) throw new Error('task-dispatch: a new generation was admitted during cancellation; inspect task_dispatch_status');
      if (globalState.leases !== undefined && !Array.isArray(globalState.leases)) throw new Error('task-dispatch: global lease state is unavailable');
      const canonical = await canonicalWorkspace();
      const subtree = new Set(plan.subtree);
      // Include admissions a subtree session started whose child identity is not yet known.
      const cascaded = state.records.filter(r => r !== record && r.state !== 'cancelled' &&
        ((r.childID && subtree.has(r.childID)) || (!r.childID && r.inFlight && subtree.has(r.parentID))));
      const releasedLeases = (globalState.leases ?? []).filter(l => (l.workspace === canonical && l.key === record.key) ||
        (l.childID && subtree.has(l.childID)) || (!l.childID && l.parentID && subtree.has(l.parentID)));
      const at = now();
      const releasedLocks = [
        ...(record.writePaths?.length ? [{ kind:'workspace-ownership', sessionID:record.childID, workKey:record.workKey, paths:record.writePaths }] : []),
        ...cascaded.filter(r => r.writePaths?.length).map(r => ({ kind:'workspace-ownership', sessionID:r.childID, workKey:r.workKey, paths:r.writePaths, cascade:true })),
        ...releasedLeases.map(l => ({ kind:'global-writer-lease', sessionID:l.childID ?? null, paths:l.paths })),
      ];
      const cancellation = { generation:plan.generation, reason:input.reason, cancelledAt:at, cancelledBy:callerID, previousState:plan.priorState,
        interrupted, interruptFailures, pendingPermissionsRejected:rejected.size, permissionCleanup:permissionsSupported ? 'rejected' : 'unavailable',
        releasedWritePaths:record.writePaths ?? [] };
      Object.assign(record, { state:'cancelled', cancellation, inFlight:null, writePaths:[], updatedAt:at });
      for (const other of cascaded) Object.assign(other, { state:'cancelled', inFlight:null, writePaths:[], updatedAt:at,
        cancellation:{ generation:other.admissionGeneration, reason:input.reason, cancelledAt:at, cancelledBy:callerID, previousState:other.state,
          cascadeFrom:record.childID, releasedWritePaths:other.writePaths ?? [] } });
      await save();
      if (releasedLeases.length) { globalState.leases = globalState.leases.filter(l => !releasedLeases.includes(l)); await saveGlobal(); }
      return { content:JSON.stringify({ ...plan.identity, status:'cancelled', reason:input.reason, cancelledAt:at, cancelledBy:callerID,
        interrupted, interruptFailures, pendingPermissionsRejected:rejected.size, permissionCleanup:cancellation.permissionCleanup,
        cascadedCancellations:cascaded.map(r => r.childID), releasedLocks,
        next:'Ownership is released; admit the replacement lane with a new workKey (or resume this child explicitly with sessionID and writePaths).' }),
        metadata:{ sessionID:record.childID, status:'cancelled' } };
    }));
  };
}

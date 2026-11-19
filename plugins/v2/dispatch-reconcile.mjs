// Settlement of dispatch-ownership rows whose children stopped without the
// handoff call recording it: a child aborted or interrupted natively, a
// background child that failed, or an admission whose owning server process
// exited (service restart). Such rows otherwise stay `running` (or keep a dead
// `inFlight` admission), and their global writer leases keep rejecting new
// overlapping lanes.
//
// Conservative by construction: a row is never settled while its admission is
// in flight in a live process, while its child or any descendant is active,
// or while an unreported native child of the same parent and role is active.
// A successful native outcome is never turned into a failure: only a dead
// in-flight marker is cleared so the result stays collectable/deliverable.
// Lock ordering is global-before-workspace, as in admission.
import { descendant } from './dispatch-registry.mjs';

export const pidLive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unknown owner: assume alive
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};
const busy = (sessions, childID) => sessions.some(s => s.active && (s.id === childID || descendant(sessions, s.id, childID)));

export function createStaleReconciler({ registry, globalRegistry, workspace, canonicalWorkspace, loadSessions, loadTerminalReceipt, now = Date.now, isPidLive = pidLive }) {
  const receiptFor = async record => {
    const binding = record.completionBinding;
    if (!record.childID || !binding?.marker || binding.generation !== record.admissionGeneration || typeof loadTerminalReceipt !== 'function') return undefined;
    try {
      const receipt = await loadTerminalReceipt({ sessionID:record.childID, marker:binding.marker, promptHash:`${binding.promptHash},${binding.prefixedPromptHash}` });
      return ['succeeded','failed','interrupted'].includes(receipt?.outcome) ? receipt : undefined;
    } catch { return undefined; }
  };
  // Decide one row from read-only evidence; undefined leaves it untouched.
  const decide = async (record, sessions) => {
    if (record.inFlight && isPidLive(record.ownerPid)) return undefined;
    if (!record.childID) {
      if (!record.inFlight) return undefined;
      // Native may have accepted a child before reporting its identity.
      if (sessions.some(s => s.active && s.parentID === record.parentID && s.agent === record.agent && (s.created ?? Infinity) >= (record.startedAt ?? 0))) return undefined;
      return { state:'interrupted', reason:'admission_owner_exited' };
    }
    const child = sessions.find(s => s.id === record.childID);
    if (!child) return { state:'interrupted', reason:'child_missing' };
    if (busy(sessions, record.childID)) return undefined;
    const receipt = await receiptFor(record);
    if (receipt && receipt.outcome !== 'succeeded') return { state:receipt.outcome, reason:'native_terminal_outcome', nativeOutcome:receipt.outcome };
    if (!record.inFlight) return undefined; // idle and not failed: awaiting collection, not stale
    if (receipt) return { state:record.completionBinding?.background ? record.state : 'paused', reason:'admission_owner_exited', nativeOutcome:'succeeded' };
    return { state:'interrupted', reason:'admission_owner_exited' };
  };
  const apply = (record, decision, globalState, canonical, at) => {
    const released = (globalState.leases ?? []).filter(l => (l.workspace === canonical && l.key === record.key) || (record.childID && l.childID === record.childID));
    record.reconciliation = { generation:record.admissionGeneration, reason:decision.reason, previousState:record.state, observedAt:at,
      ...(decision.nativeOutcome ? { nativeOutcome:decision.nativeOutcome } : {}),
      ...(record.inFlight ? { clearedInFlight:true, ownerPid:record.ownerPid ?? null } : {}),
      releasedLeases:released.map(l => ({ sessionID:l.childID ?? null, paths:l.paths })) };
    Object.assign(record, { state:decision.state, inFlight:null, updatedAt:at });
    if (released.length) globalState.leases = globalState.leases.filter(l => !released.includes(l));
    return released.length > 0;
  };
  const withLocks = run => globalRegistry('all-writers', async (globalState, saveGlobal) => registry(workspace, async (state, save) => {
    if (globalState.leases !== undefined && !Array.isArray(globalState.leases)) throw new Error('task-dispatch: global lease state is unavailable');
    return run(state, globalState, save, saveGlobal);
  }));
  // Startup/plugin init: settle every stale `starting`/`running` row or dead admission.
  const reconcile = () => withLocks(async (state, globalState, save, saveGlobal) => {
    const candidates = state.records.filter(r => r.inFlight || ['starting','running'].includes(r.state));
    if (!candidates.length) return [];
    const sessions = await loadSessions(), canonical = await canonicalWorkspace(), at = now(), settled = [];
    let leasesChanged = false;
    for (const record of candidates) {
      const decision = await decide(record, sessions);
      if (!decision) continue;
      leasesChanged = apply(record, decision, globalState, canonical, at) || leasesChanged;
      settled.push({ key:record.key, sessionID:record.childID ?? null, state:record.state, reason:decision.reason });
    }
    if (settled.length) await save();
    if (leasesChanged) await saveGlobal();
    return settled;
  });
  // Runtime: settle one exact generation once its native terminal outcome is a failure or interruption.
  const settleGeneration = (key, generation) => withLocks(async (state, globalState, save, saveGlobal) => {
    const record = state.records.find(r => r.key === key);
    if (!record || record.admissionGeneration !== generation || !['starting','running'].includes(record.state)) return undefined;
    const sessions = await loadSessions();
    const decision = await decide(record, sessions);
    if (!decision || decision.reason !== 'native_terminal_outcome') return undefined;
    if (apply(record, decision, globalState, await canonicalWorkspace(), now())) await saveGlobal();
    await save();
    return record.state;
  });
  return { reconcile, settleGeneration };
}

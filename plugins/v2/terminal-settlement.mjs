import { lineage, descendant } from './dispatch-registry.mjs';
import { getIntent } from './task-intent.mjs';
import { modelReference } from './dispatch-routing.mjs';

const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value);
export function terminalSettlementEligibility(record, child, sessions, callerID) {
  if (!record?.completionBinding?.background || record.completionBinding.generation !== record.admissionGeneration)
    return 'completion binding does not match the recorded background generation';
  if (!['running','paused','denied','settled'].includes(record.state)) return 'record is not awaiting terminal reconciliation';
  if (record.inFlight) return 'admission is in flight';
  if (!child || child.active !== false) return 'child inactivity is not verified';
  if (record.parentID !== callerID || child.parentID !== callerID) return 'caller is not the recorded native parent';
  if (lineage(sessions, child.id) !== record.rootID || lineage(sessions, callerID) !== record.rootID)
    return 'child is outside the recorded root';
  if (child.canonicalSessionID || sessions.find(s => s.id === callerID)?.canonicalSessionID ||
      sessions.find(s => s.id === record.rootID)?.canonicalSessionID)
    return 'historical transcripts cannot reconcile ownership';
  if (child.agent !== record.agent || !modelReference(child.model) || modelReference(child.model) !== modelReference(record.routing?.selected))
    return 'native role or model does not match the admitted generation';
  if (sessions.some(s => s.active && descendant(sessions, s.id, child.id))) return 'an active descendant remains';
}

function safeReceipt(value) {
  if (!value || !['succeeded','failed','interrupted'].includes(value.outcome) ||
      !identifier(value.promptID) || !identifier(value.idleID) ||
      !Number.isSafeInteger(value.idleSeq) || value.idleSeq < 1) return undefined;
  const receipt = { outcome:value.outcome, promptID:value.promptID, idleID:value.idleID, idleSeq:value.idleSeq };
  if (value.assistantID !== undefined || value.assistantSeq !== undefined) {
    if (!identifier(value.assistantID) || !Number.isSafeInteger(value.assistantSeq) || value.assistantSeq < 1 || value.assistantSeq >= value.idleSeq) return undefined;
    Object.assign(receipt, { assistantID:value.assistantID, assistantSeq:value.assistantSeq });
  }
  if (value.outcome === 'succeeded' && !receipt.assistantID) return undefined;
  if (value.completedAt !== undefined) {
    if (!Number.isSafeInteger(value.completedAt) || value.completedAt < 1) return undefined;
    receipt.completedAt = value.completedAt;
  }
  return receipt;
}

// Explicit parent mutation, not status-side cleanup. Global-before-workspace lock
// ordering matches admission. Native observations are read-only and revalidated;
// this does not claim an atomic transaction with native execution or inputs.
export function createTerminalSettler({ registry, globalRegistry, workspace, canonicalWorkspace, loadSessions, loadTerminalReceipt, now }) {
  return async (input, context) => globalRegistry('all-writers', async (globalState, saveGlobal) =>
    registry(workspace, async (state, save) => {
      const sessions = await loadSessions(), rootID = lineage(sessions, context.sessionID);
      const record = state.records.find(r => r.key === `${rootID}\0${input.taskId}\0${input.workKey}`);
      if (!record || record.parentID !== context.sessionID || record.childID !== input.sessionID || record.admissionGeneration !== input.generation)
        throw new Error('task-dispatch: terminal reconciliation must name the recorded parent, task, work key, child, and generation exactly');
      const current = getIntent(state, rootID, input.taskId);
      if (!current || !Number.isSafeInteger(record.intentRevision) || current.revision < record.intentRevision)
        throw new Error('task-dispatch: admitted and current intent identities are required for reconciliation');
      const blocked = terminalSettlementEligibility(record, sessions.find(s => s.id === input.sessionID), sessions, context.sessionID);
      if (blocked) throw new Error(`task-dispatch: terminal reconciliation blocked: ${blocked}`);
      const binding = record.completionBinding;
      const query = { sessionID:input.sessionID, marker:binding.marker, promptHash:`${binding.promptHash},${binding.prefixedPromptHash}` };
      const receipt = safeReceipt(await loadTerminalReceipt(query));
      if (!receipt) throw new Error('task-dispatch: no exact native terminal outcome; idle alone is not evidence');
      if (receipt.outcome === 'succeeded' && current.revision === record.intentRevision)
        throw new Error('task-dispatch: use task_dispatch_collect for a successful current-intent generation');
      const latest = await loadSessions();
      const changed = terminalSettlementEligibility(record, latest.find(s => s.id === input.sessionID), latest, context.sessionID);
      const confirmed = safeReceipt(await loadTerminalReceipt(query));
      if (changed || JSON.stringify(confirmed) !== JSON.stringify(receipt))
        throw new Error('task-dispatch: native terminal boundary changed during reconciliation');
      const canonical = await canonicalWorkspace();
      if (globalState.leases !== undefined && !Array.isArray(globalState.leases))
        throw new Error('task-dispatch: global lease state is unavailable');
      const leases = (globalState.leases ?? []).filter(l => l.workspace === canonical && l.key === record.key);
      if (leases.length > 1 || leases.some(l => l.childID !== record.childID || l.parentID !== record.parentID || l.inFlight))
        throw new Error('task-dispatch: global lease identity is not settled for this exact owner');
      if (record.terminalSettlement && (record.terminalSettlement.generation !== input.generation ||
          JSON.stringify(record.terminalSettlement.receipt) !== JSON.stringify(receipt)))
        throw new Error('task-dispatch: recorded terminal settlement does not match this generation');
      if (!record.terminalSettlement) {
        const settlement = { generation:input.generation, intentRevision:record.intentRevision,
          observedCurrentIntentRevision:current.revision, acceptedForCurrentIntent:false, receipt, reconciledAt:now() };
        record.terminalSettlement = settlement;
        record.terminalHistory = [...(record.terminalHistory ?? []), settlement].slice(-16);
        record.state = 'settled';
        record.updatedAt = now();
        // Preserve denied-operation evidence, check IDs, scope and native identity.
        // Settled is deliberately distinct from completed and grants no success.
        await save();
      }
      if (leases.length) {
        globalState.leases = globalState.leases.filter(l => !leases.includes(l));
        await saveGlobal();
      }
      return { content:JSON.stringify({sessionID:input.sessionID,generation:input.generation,status:'settled',
        ...record.terminalSettlement, ownershipReleased:true, inferenceStarted:false}) };
    }));
}

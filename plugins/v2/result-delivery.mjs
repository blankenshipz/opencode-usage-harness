// Reliable delivery of a handoff's child result to its parent session.
//
// A foreground handoff normally returns the child's report as its tool result;
// a background handoff is reported by the native subagent completion notice.
// Either path can be lost: the parent's wait can be aborted or interrupted,
// the child can finish after the parent's tool call returned, or core can fail
// to record a returned tool result (the parent part stays "running" and is
// later failed as "Tool execution interrupted" although the child succeeded).
//
// Every admitted generation therefore carries a durable `resultDelivery`
// binding. Once the child reaches an exact native terminal outcome this
// watcher checks read-only evidence: a completed foreground tool part or a
// native subagent notice for the child means the parent has the result.
// Otherwise, after a short grace period, it delivers exactly one synthetic
// message with the child's final report and its real outcome. The message ID
// is derived from the child and generation so a repeated delivery is rejected
// natively, and the binding records the delivery so it is never repeated.
import crypto from 'node:crypto';

export const RESULT_DELIVERY_GRACE_MS = 15000;
export const RESULT_DELIVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RESULT_DELIVERY_REPORT_LIMIT = 16000;
const DELAYS = [2000, 5000, 10000, 30000];
const FINAL = new Set(['confirmed', 'delivered', 'not_applicable', 'cancelled', 'superseded', 'abandoned']);
const NATIVE_STATE = { succeeded:'completed', failed:'error', interrupted:'cancelled' };
const attribute = value => String(value ?? '').replace(/[\r\n"<>]/g, ' ').slice(0, 240);

export const resultDeliveryID = (childID, generation) =>
  `msg_harness_result_${crypto.createHash('sha256').update(`${childID}\0${generation}`).digest('hex').slice(0, 24)}`;

export function deliveredReport(report, outcome) {
  const text = typeof report === 'string' && report.trim() ? report : outcome === 'succeeded' ? 'Subagent completed without a text response.' : `Subagent ${outcome}; it produced no final report.`;
  return text.length > RESULT_DELIVERY_REPORT_LIMIT
    ? `${text.slice(0, RESULT_DELIVERY_REPORT_LIMIT)}\n[harness: final report truncated at ${RESULT_DELIVERY_REPORT_LIMIT} of ${text.length} characters]` : text;
}
export function resultSyntheticInput({ delivery, childID, outcome, report, reason, resume = true }) {
  const state = NATIVE_STATE[outcome] ?? 'error';
  const collect = { taskId:delivery.taskId, workKey:delivery.workKey, sessionID:childID, generation:delivery.generation };
  const bounded = deliveredReport(report, outcome);
  const next = outcome === 'succeeded'
    ? `This is the child's actual final report: the child SUCCEEDED, even if the original tool call shows aborted, errored or running. Re-read it with task_dispatch_collect(${JSON.stringify(collect)}); do not relaunch the child for this result.`
    : `The child ended ${outcome}. Inspect task_dispatch_status before any explicit continuation of the same child.`;
  return {
    id: resultDeliveryID(childID, delivery.generation), sessionID: delivery.parentID, ...(resume ? {} : { resume:false }),
    description: delivery.description,
    text: `<subagent sessionID="${attribute(childID)}" state="${state}" outcome="${outcome}" generation="${delivery.generation}" description="${attribute(delivery.description)}">\n${bounded}\n</subagent>\n\nHarness result delivery (${delivery.mode} handoff ${JSON.stringify(collect)}): the original handoff result did not reach this session (${reason}). ${next}`,
    metadata: { source:'subagent', harness:'result_delivery', childID, agent:delivery.agent, state, outcome, generation:delivery.generation, taskId:delivery.taskId, workKey:delivery.workKey },
  };
}

// Pure decision over one evidence snapshot.
export function deliveryDecision({ delivery, evidence, now, graceMs = RESULT_DELIVERY_GRACE_MS }) {
  const terminal = evidence?.terminal;
  if (!terminal || !['succeeded','failed','interrupted'].includes(terminal.outcome)) return { action:'wait' };
  const notices = Array.isArray(evidence.notices) ? evidence.notices : [];
  if (notices.some(n => n?.harness && n.generation === delivery.generation)) return { action:'final', status:'delivered', via:'harness_synthetic' };
  if (delivery.mode === 'foreground' && evidence.tool?.status === 'completed' && delivery.toolReturned) return { action:'final', status:'confirmed', via:'tool_result' };
  if (notices.some(n => n && !n.harness)) return { action:'final', status:'confirmed', via:'native_notice' };
  // A returned foreground call whose part is not visible (for example a nested
  // call) cannot be verified; never risk a duplicate report for it.
  if (delivery.mode === 'foreground' && delivery.toolReturned && !evidence.tool) return { action:'final', status:'confirmed', via:'tool_result_unverified' };
  const settledAt = Math.max(terminal.completedAt ?? 0, delivery.returnedAt ?? 0);
  if (now - settledAt < graceMs) return { action:'wait' };
  const reason = !delivery.toolReturned
    ? 'the handoff tool call was aborted or interrupted before it returned the result'
    : delivery.mode === 'foreground'
      ? `the returned tool result was not recorded; the tool part is ${evidence.tool?.status ?? 'missing'}${evidence.tool?.errorType ? ` (${evidence.tool.errorType})` : ''}`
      : 'no native completion notice reached this session';
  return { action:'deliver', outcome:terminal.outcome, reason,
    // Never restart a parent the user explicitly interrupted; the notice waits for its next turn.
    resume: !(evidence.parentIdleOutcome === 'interrupted' && evidence.parentActive === false) };
}

export function createResultDelivery({ registry, workspace, ctx, loadEvidence, loadFinalText, now = Date.now,
  schedule = (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, cancel = clearTimeout,
  graceMs = RESULT_DELIVERY_GRACE_MS, maxAgeMs = RESULT_DELIVERY_MAX_AGE_MS }) {
  const timers = new Map(), running = new Map();
  let disposed = false;
  const finish = (key, generation, patch, extra) => registry(workspace, async (state, save) => {
    const record = state.records.find(r => r.key === key);
    const delivery = record?.resultDelivery;
    if (!record || record.admissionGeneration !== generation || delivery?.generation !== generation || delivery.status !== 'pending') return delivery?.status ?? 'superseded';
    record.resultDelivery = { ...delivery, ...patch, settledAt:now() };
    extra?.(record);
    record.updatedAt = Date.now(); await save();
    return patch.status;
  });
  const run = async (key, generation) => {
    const record = await registry(workspace, async state => structuredClone(state.records.find(r => r.key === key) ?? null));
    const delivery = record?.resultDelivery;
    if (!record || record.admissionGeneration !== generation || delivery?.generation !== generation) return 'superseded';
    if (delivery.status !== 'pending') return delivery.status;
    if (record.state === 'cancelled') return finish(key, generation, { status:'cancelled' });
    // The handoff call is still waiting in a live process; it returns the result itself.
    if (delivery.toolReturned === undefined && record.inFlight && record.ownerPid === process.pid) return 'pending';
    if (!record.childID || typeof loadEvidence !== 'function') return 'pending';
    if (now() - delivery.since > maxAgeMs) return finish(key, generation, { status:'abandoned' });
    const evidence = await loadEvidence({ childID:record.childID, parentID:delivery.parentID, marker:delivery.marker,
      promptHash:delivery.promptHash, messageID:delivery.messageID, callID:delivery.callID, since:delivery.since });
    const decision = deliveryDecision({ delivery, evidence, now:now(), graceMs });
    if (decision.action === 'wait') return 'pending';
    const terminal = evidence.terminal;
    if (decision.action === 'final') return finish(key, generation, { status:decision.status, via:decision.via, outcome:terminal.outcome });
    if (typeof ctx?.session?.synthetic !== 'function') return 'pending';
    let report = '', truncated = false, length = 0;
    if (terminal.assistantID && typeof loadFinalText === 'function') {
      const final = await loadFinalText({ sessionID:record.childID, assistantID:terminal.assistantID }).catch(() => undefined);
      if (typeof final?.text === 'string') ({ text:report } = final), truncated = final.truncated === true, length = final.length ?? report.length;
    }
    const input = resultSyntheticInput({ delivery, childID:record.childID, outcome:decision.outcome, report, reason:decision.reason, resume:decision.resume });
    try { await ctx.session.synthetic(input); }
    catch (error) {
      // The deterministic ID was already admitted: an earlier attempt delivered it.
      if (!/conflict/i.test(String(error?.message ?? error?._tag ?? error))) throw error;
    }
    return finish(key, generation, { status:'delivered', via:'harness_synthetic', outcome:decision.outcome, reason:decision.reason, noticeID:input.id, deliveredAt:now() }, current => {
      // A successful child is recorded as succeeded even when the parent's wait was aborted.
      if (decision.outcome !== 'succeeded' || delivery.mode !== 'foreground' || current.state === 'completed') return;
      current.outcomeCorrection = { generation, previousState:current.state, observedOutcome:'succeeded', reason:decision.reason, at:now() };
      current.state = 'completed';
      current.foregroundResult = { generation, sessionID:current.childID, status:'completed', output:deliveredReport(report, 'succeeded'),
        truncated:truncated || report.length > RESULT_DELIVERY_REPORT_LIMIT, length:Math.max(length, report.length), completedAt:terminal.completedAt ?? now(),
        receipt:{ promptID:terminal.promptID, assistantID:terminal.assistantID, idleID:terminal.idleID, ...(terminal.completedAt ? { completedAt:terminal.completedAt } : {}) } };
    });
  };
  const check = (key, generation) => {
    const id = `${key}\0${generation}`;
    if (running.has(id)) return running.get(id);
    const pending = run(key, generation).finally(() => running.delete(id));
    running.set(id, pending);
    return pending;
  };
  const track = (key, generation, attempt = 0) => {
    const id = `${key}\0${generation}`;
    if (disposed || (attempt === 0 && timers.has(id))) return;
    timers.set(id, schedule(async () => {
      timers.delete(id);
      let status = 'pending';
      try { status = await check(key, generation); } catch { /* evidence is retried at the next interval */ }
      if (!FINAL.has(status)) track(key, generation, attempt + 1);
    }, DELAYS[Math.min(attempt, DELAYS.length - 1)]));
  };
  // Re-arm every pending delivery after a restart or plugin reload.
  const resume = async () => {
    const pending = await registry(workspace, async state => state.records
      .filter(r => r.resultDelivery?.status === 'pending' && r.resultDelivery.generation === r.admissionGeneration)
      .map(r => [r.key, r.admissionGeneration]));
    for (const [key, generation] of pending) track(key, generation);
    return pending.length;
  };
  const dispose = () => { disposed = true; for (const timer of timers.values()) cancel(timer); timers.clear(); };
  return { check, track, resume, dispose };
}

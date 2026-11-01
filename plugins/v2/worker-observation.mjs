// Passive observations only. Silence and native activity are not task acceptance.
const time = v => Number.isSafeInteger(v) && v > 0 ? v : undefined;
const age = (v, now) => time(v) && now >= v ? now-v : undefined;
const names = new Set(['read','write','edit','patch','apply_patch','shell','bash','glob','grep','list','question','plan_enter','plan_exit','task_dispatch','task_dispatch_collect','task_dispatch_status','task_intent','task_outcome','task_artifact','webfetch']);
function tool(t) {
  const result={name:names.has(t?.name)?t.name:'other',status:['streaming','completed','error','cancelled'].includes(t?.status)?t.status:'other'};
  for (const key of ['messageID','toolID']) if (typeof t?.[key] === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(t[key])) result[key]=t[key];
  for (const key of ['startedAt','completedAt']) if (time(t?.[key])) result[key]=t[key];
  if (Number.isSafeInteger(t?.exitCode)) result.exitCode=t.exitCode;
  if (t?.timedOut === true) result.timedOut=true;
  return result;
}
export function workerObservation(record, native, current, records, now) {
  const activity = native?.activity;
  const runningTools = native?.active === true ? (Array.isArray(activity?.runningTools) ? activity.runningTools : []).slice(0,3).map(t => ({...tool(t), elapsedMs:age(t?.startedAt,now)})) : [];
  const checkpoint = record.progressCheckpoint;
  const progress = checkpoint?.intentRevision === current?.revision && checkpoint?.observedDuringGeneration === record.admissionGeneration ? checkpoint : undefined;
  const dependencies = progress?.progressState === 'waiting_dependency' ? (progress.dependencySessionIDs ?? []).map(id => {
    const owner = records.find(r => r.rootID === record.rootID && r.childID === id);
    return {sessionID:id, observation:owner ? 'same_root_owner_recorded' : 'unobserved'};
  }) : undefined;
  let phase = 'unknown';
  if (native?.active === true) phase = runningTools.length ? 'tool_running' : 'execution_active';
  else if (native?.active === false) {
    if (['compacting','awaiting_continuation','awaiting_recovery'].includes(record.state)) phase=record.state;
    else if (record.denial) phase='blocked';
    else if (record.state === 'completed') phase='awaiting_parent_decision';
    else if (record.state === 'running') phase='awaiting_result_inspection';
    else phase=record.state === 'failed' ? 'failed_awaiting_recovery' : 'idle';
  }
  const timing = record.handoffTimings?.find(r => r.generation === record.admissionGeneration && r.childID === record.childID);
  return {
    workerActivity:{observedAt:now, nativeActive:native?.active ?? null, runningTools,
      ...(activity?.lastCompletedTool ? {lastCompletedTool:tool(activity.lastCompletedTool)} : {}),
      ...(time(activity?.lastModelResponseAt) ? {lastModelResponseAt:activity.lastModelResponseAt} : {}),
      ...(time(native?.lastVisibleTextAt) ? {lastVisibleTextAt:native.lastVisibleTextAt, visibleSilenceMs:age(native.lastVisibleTextAt,now)} : {}),
      verification:'unverified', limitation:'Bounded native metadata; tool completion and silence do not establish useful progress, a stall, or accepted task completion.'},
    handoff:{phase, responsibleParentID:record.parentID, generation:record.admissionGeneration,
      ...(phase === 'awaiting_parent_decision' && time(timing?.collectedAt) ? {since:timing.collectedAt,elapsedMs:age(timing.collectedAt,now)} : {}),
      ...(progress ? {reportedProgress:{status:progress.status,progressState:progress.progressState,recordedAt:progress.recordedAt,selfReported:true,generationBinding:'receipt_time_only_not_execution_provenance'}} : {}),
      ...(dependencies ? {dependencies, dependencyBasis:'self_report_may_arrive_late; dependency execution and readiness not inferred'} : {})},
  };
}

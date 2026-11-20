// r26 item 1: fail closed on review.
//
// While a required independent review in the same root is pending (dispatched,
// not yet completed) or gated (its dispatch was refused, e.g. because the
// author's terminal receipt was missing), the harness refuses:
//  - shell `git push` / `git merge` that targets main/master (or a bare push
//    or merge while the checkout is on main/master), and
//  - task_outcome scope:"task" status:"completed" for that root.
// A gate clears only when a required review of the same task completes after
// the gate was recorded. Nothing here approves, rejects or answers asks.
const DONE = new Set(['completed']);
const reviewDone = r => DONE.has(r.state) || (r.foregroundResult && r.foregroundResult.generation === r.admissionGeneration && r.foregroundResult.status === 'completed');
const isRequiredReview = r => r?.routing?.reviewIndependence === 'required';

export function recordReviewGate(state, { rootID, taskId, reason, at }) {
  state.reviewGates = (state.reviewGates ?? []).filter(g => !(g.rootID === rootID && g.taskId === taskId));
  state.reviewGates.push({ rootID, taskId, reason: String(reason ?? '').slice(0, 300), at });
  if (state.reviewGates.length > 200) state.reviewGates = state.reviewGates.slice(-200);
}

export function pendingReviewGate(state, rootID) {
  const records = (state.records ?? []).filter(r => r.rootID === rootID);
  const pending = records.filter(r => isRequiredReview(r) && !reviewDone(r) && !['denied', 'cancelled', 'superseded', 'not_started'].includes(r.state))
    .map(r => ({ kind: 'pending', taskId: r.taskId, workKey: r.workKey, childID: r.childID, state: r.state }));
  const gated = (state.reviewGates ?? []).filter(g => g.rootID === rootID)
    .filter(g => !records.some(r => isRequiredReview(r) && r.taskId === g.taskId && reviewDone(r) && (r.updatedAt ?? 0) >= g.at))
    .map(g => ({ kind: 'gated', taskId: g.taskId, reason: g.reason, at: g.at }));
  return [...pending, ...gated];
}

const segments = command => command.split(/&&|\|\||;|\n|\|/).map(s => s.trim()).filter(Boolean);
// Returns true when a command segment is a git push/merge that can land on main.
export function mainLandingCommand(command, currentBranch) {
  for (const seg of segments(command)) {
    const words = seg.split(/\s+/);
    const g = words.findIndex(w => w === 'git' || w.endsWith('/git'));
    if (g < 0) continue;
    let i = g + 1;
    while (i < words.length && words[i].startsWith('-')) i += (['-C', '-c'].includes(words[i]) ? 2 : 1);
    const sub = words[i], rest = words.slice(i + 1);
    if (sub !== 'push' && sub !== 'merge') continue;
    const mentionsMain = rest.some(w => /(^|[:/+])(main|master)$/.test(w) || /^(HEAD:)?refs\/heads\/(main|master)$/.test(w));
    if (sub === 'push' && mentionsMain) return true;
    const positional = rest.filter(w => !w.startsWith('-'));
    if (sub === 'push' && positional.length <= 1 && ['main', 'master'].includes(currentBranch)) return true;
    if (sub === 'merge' && ['main', 'master'].includes(currentBranch)) return true;
    if (sub === 'push' && rest.includes('--all')) return true;
  }
  return false;
}

export const gateMessage = gates => `Harness review gate: refused while an independent review is ${gates.map(g => `${g.kind} (task ${g.taskId}${g.reason ? `: ${g.reason.slice(0, 120)}` : ''})`).join('; ')}. Do not merge or push to main and do not report DEPLOY-READY / done; collect or re-dispatch the required review first, or report BLOCKED to your parent.`;

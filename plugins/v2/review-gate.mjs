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

export const GATE_TTL_MS = 24 * 3600_000;
const LIVE = new Set(['starting', 'running', 'awaiting_continuation', 'awaiting_recovery']);
// taskId: limit to one task (completion); omitted: any task of the root (git landing).
export function pendingReviewGate(state, rootID, { taskId, now = Date.now() } = {}) {
  const records = (state.records ?? []).filter(r => r.rootID === rootID && (taskId === undefined || r.taskId === taskId));
  const pending = records.filter(r => isRequiredReview(r) && !reviewDone(r) && (LIVE.has(r.state) || r.inFlight))
    .map(r => ({ kind: 'pending', taskId: r.taskId, workKey: r.workKey, childID: r.childID, state: r.state }));
  const gated = (state.reviewGates ?? []).filter(g => g.rootID === rootID && (taskId === undefined || g.taskId === taskId) && now - g.at < GATE_TTL_MS)
    .filter(g => !records.some(r => isRequiredReview(r) && r.taskId === g.taskId && reviewDone(r) && (r.updatedAt ?? 0) >= g.at))
    .map(g => ({ kind: 'gated', taskId: g.taskId, reason: g.reason, at: g.at }));
  return [...pending, ...gated];
}

const segments = command => command.replace(/["'\\]/g, ' ').split(/&&|\|\||;|\n|\||\(|\)|`|\$\(/).map(s => s.trim()).filter(Boolean);
const MAIN = /(^|[:/+])(main|master)$/;
// True when a command segment is a git push/merge that can land on main. Quotes and
// nested shells (bash -c "...") are flattened; an unknown branch counts as main.
export function mainLandingCommand(command, currentBranch) {
  const onMain = currentBranch === undefined || ['main', 'master', 'HEAD'].includes(currentBranch);
  for (const seg of segments(command)) {
    const words = seg.split(/\s+/);
    for (let g = 0; g < words.length; g++) {
      if (!(words[g] === 'git' || words[g].endsWith('/git'))) continue;
      let i = g + 1;
      while (i < words.length && words[i].startsWith('-')) i += (['-C', '-c', '--git-dir', '--work-tree'].includes(words[i]) ? 2 : 1);
      const sub = words[i], rest = words.slice(i + 1);
      if (sub === 'push') {
        if (rest.some(w => ['--all', '--mirror'].includes(w))) return true;
        const positional = rest.filter(w => !w.startsWith('-'));
        if (positional.slice(1).some(w => MAIN.test(w) || /^\+?(HEAD:)?refs\/heads\/(main|master)$/.test(w))) return true;
        if (onMain && (positional.length <= 1 || positional.slice(1).some(w => /^\+?HEAD(:|$)/.test(w) || w === '@'))) return true;
      } else if (sub === 'merge' && onMain && !rest.some(w => ['--abort', '--quit'].includes(w))) return true;
    }
  }
  return false;
}

export const gateMessage = gates => `Harness review gate: refused while an independent review is ${gates.map(g => `${g.kind} (task ${g.taskId}${g.reason ? `: ${g.reason.slice(0, 120)}` : ''})`).join('; ')}. Do not merge or push to main and do not report DEPLOY-READY / done; collect or re-dispatch the required review first, or report BLOCKED to your parent.`;

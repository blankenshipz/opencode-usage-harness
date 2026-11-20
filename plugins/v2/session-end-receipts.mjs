// r20 item 7: the harness writes the terminal receipt and a task outcome at session end.
//
// When result delivery observes a dispatched child's native terminal evidence
// (succeeded, failed or interrupted), the harness itself records:
//  - record.harnessTerminalReceipt on the dispatch record (generation-bound), and
//  - one source:"harness" scope:"session_end" line in telemetry/task-outcomes.jsonl.
// The harness outcome only states how the session ended. It never claims that
// contracted checks passed (checksVerified:false), so a reader can never treat
// it, or a blocked/parked child, as a pass. Self-reported task_outcome records
// are unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import { statePath } from './paths.mjs';

const STATUS = { succeeded: 'ended', failed: 'failed', interrupted: 'interrupted' };

export function harnessTerminalReceipt({ record, terminal, now }) {
  if (!record || !terminal || !STATUS[terminal.outcome]) return undefined;
  return { by: 'harness', generation: record.admissionGeneration, sessionID: record.childID, outcome: terminal.outcome,
    ...(typeof terminal.promptID === 'string' ? { promptID: terminal.promptID } : {}),
    ...(typeof terminal.assistantID === 'string' ? { assistantID: terminal.assistantID } : {}),
    ...(typeof terminal.idleID === 'string' ? { idleID: terminal.idleID } : {}),
    ...(Number.isFinite(terminal.completedAt) ? { completedAt: terminal.completedAt } : {}), writtenAt: now };
}

export function sessionEndOutcome({ record, receipt }) {
  return { schemaVersion: 2, source: 'harness', scope: 'session_end', recordedAt: new Date(receipt.writtenAt).toISOString(),
    sessionId: record.childID, parentSessionId: record.parentID, taskId: record.taskId, workKey: record.workKey, agent: record.agent,
    generation: receipt.generation, status: STATUS[receipt.outcome], outcome: receipt.outcome, checksVerified: false,
    ...(record.parked?.generation === receipt.generation ? { parked: { requestID: record.parked.requestID } } : {}) };
}

export const appendOutcome = async (line, { file = statePath('telemetry', 'task-outcomes.jsonl') } = {}) => {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'a', 0o600);
  try { await handle.writeFile(JSON.stringify(line) + '\n'); } finally { await handle.close(); }
};

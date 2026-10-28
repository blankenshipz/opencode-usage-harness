// Built-in OpenCode agents retain their stock tool contracts.  Keep this list
// deliberately exact: configured harness roles must opt in through the
// harness dispatch path instead of matching by a descriptive name.
const nativeAgents = new Set(['build', 'plan', 'general', 'explore']);
const harnessRoles = ['router', 'coordinator', 'scout', 'quick-builder', 'builder', 'builder-high', 'deep-debugger', 'deep-debugger-high', 'architect', 'reviewer', 'verifier', 'maximum', 'maximum-max'];
const roleAliases = new Map(harnessRoles.flatMap(role => [[role, role], [`harness-${role}`, role]]));

// Role semantics may follow the visible alias, but persisted session and
// dispatch identities must remain the exact configured ID.
export const canonicalHarnessRole = agent => roleAliases.get(agent);
export const harnessRoleIDs = role => {
  const canonical = canonicalHarnessRole(role);
  return canonical ? [canonical, `harness-${canonical}`] : [];
};

export const isNativeAgent = agent => typeof agent === 'string' && nativeAgents.has(agent);

// A native caller can deliberately enter the harness contract, but a harness
// caller cannot become native merely by omitting one required field.
export const isHarnessDispatchInput = input => !!input && typeof input === 'object' &&
  ['taskId', 'workKey', 'operation', 'requiredCapabilities', 'writePaths', 'checkpoint', 'workReview', 'routing', 'refreshIntent', 'compact', 'recovery'].some(key => key in input);

const descendant = (sessions, childID, ancestorID) => {
  const seen = new Set(); let current = sessions.find(session => session.id === childID);
  while (current?.parentID && !seen.has(current.id)) {
    if (current.parentID === ancestorID) return true;
    seen.add(current.id); current = sessions.find(session => session.id === current.parentID);
  }
  return false;
};

const activeOwner = (record, sessions) => record.inFlight || sessions.some(session => session.active &&
  (session.id === record.childID || descendant(sessions, session.id, record.childID)));

// This is intentionally a narrow boundary for the raw built-in subagent
// executor.  It does not try to infer native writes.  It only prevents a
// native-mode call from taking over durable harness work or running alongside
// a known active harness writer.
export async function guardNativeDispatch({ registry, workspace, loadSessions, context, input, lineage }) {
  return registry(workspace, async state => {
    const sessions = await loadSessions();
    const current = sessions.find(session => session.id === context.sessionID);
    const rootID = lineage(sessions, context.sessionID);
    const historical = current?.canonicalSessionID ?? sessions.find(session => session.id === rootID)?.canonicalSessionID;
    if (historical) throw new Error(`task-dispatch: historical transcript only; continue canonical session ${historical}. Do not adopt workers or retry in this copy.`);

    const records = state.records ?? [];
    const adopted = input.sessionID && records.find(record => record.childID === input.sessionID);
    if (adopted) throw new Error(`task-dispatch: native mode cannot adopt managed child ${input.sessionID}; resume it through its recorded taskId/workKey ownership.`);

    // A switched built-in agent remains in the same root.  Pending, paused,
    // compacting, and denied records must stay on their recorded recovery path;
    // only a completed harness owner releases this root back to stock behavior.
    const managed = records.find(record => record.rootID === rootID && record.state !== 'completed');
    if (managed) throw new Error(`task-dispatch: native mode is unavailable while managed task ${managed.taskId}/${managed.workKey} is ${managed.state ?? 'active'}; finish or checkpoint that owner through task_dispatch first.`);

    const collision = records.find(record => record.rootID !== rootID && Array.isArray(record.writePaths) && record.writePaths.length && activeOwner(record, sessions));
    if (collision) throw new Error(`task-dispatch: native mode cannot start while registered writer ${collision.childID ?? collision.workKey} is active in this workspace.`);
  });
}

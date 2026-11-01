import test from 'node:test';
import assert from 'node:assert/strict';
import { rootProgressStatus, ROOT_PROGRESS_MS } from '../plugins/v2/root-progress.mjs';

test('root silence uses the current execution and actual visible text, without a timer', () => {
  const at = 2000000, start = at - ROOT_PROGRESS_MS;
  const root = { id:'root', active:true, executionStartedAt:start };
  assert.equal(rootProgressStatus(root, at).due, true);
  assert.equal(rootProgressStatus({...root,lastVisibleTextAt:at-1}, at).due, false);
  assert.equal(rootProgressStatus({...root,executionStartedAt:at-1,lastVisibleTextAt:start-1}, at).due, false);
  assert.equal(rootProgressStatus({...root,active:false}, at), undefined);
  assert.equal(rootProgressStatus({...root,parentID:'parent'}, at), undefined);
  assert.equal(rootProgressStatus({...root,canonicalSessionID:'canonical'}, at), undefined);
});

test('unavailable and malformed timestamps do not fabricate root progress pressure', () => {
  for (const clock of [undefined, null, true, -1, 0, NaN, Infinity, 3000000]) {
    assert.equal(rootProgressStatus({active:true,executionStartedAt:clock},2000000),undefined);
    if (clock !== undefined)
      assert.equal(rootProgressStatus({active:true,executionStartedAt:1,lastVisibleTextAt:clock},2000000),undefined);
  }
});

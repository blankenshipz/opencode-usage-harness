import {test} from 'node:test';
import assert from 'node:assert/strict';
import {observeAdmission, convergenceAdvice, recordProgress, normalizeProgressEvidence, progressEvidenceSchema, userActions} from '../plugins/v2/convergence.mjs';

const input = (extra = {}) => ({taskId: 't', intentRevision: 1, operation: 'implement', checkIds: ['a'], ...extra});
const state = (status = 'passed') => ({intentEvidence: {'["root","t"]': {revision: 1, checks: {a: {status, artifact: {subject: 'app', revision: 'a', generation: 1}}}}}});

test('raw receipt compatibility remains while semantic tracking ignores artifact churn and prose', () => {
  const r = {}, s = state();
  observeAdmission(r, s, input(), 'root');
  observeAdmission(r, s, input({description: 'changed prose'}), 'root');
  const advice = observeAdmission(r, s, input({operation: 'review'}), 'root');
  assert.equal(r.convergence.admissions, 1);
  assert.equal(r.convergence.progress.noProgressContinuations, 2);
  assert.equal(advice.semanticNoProgressContinuations, 2);
  s.intentEvidence['["root","t"]'].checks.a.artifact.revision = 'b';
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.admissions, 1);
  assert.equal(r.convergence.progress.noProgressContinuations, 3);
});

test('unique positive evidence resets semantic counter and duplicate evidence does not', () => {
  const r = {}, s = state();
  observeAdmission(r, s, input(), 'root');
  observeAdmission(r, s, input(), 'root');
  recordProgress(r, {failureKey: 'compile', kind: 'cause_eliminated', reference: 'receipt-1'});
  recordProgress(r, {failureKey: 'compile', kind: 'cause_eliminated', reference: 'receipt-1'});
  assert.equal(r.convergence.progress.positiveEvidenceCount, 1);
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 0);
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 1);
  recordProgress(r, {failureKey: 'compile', kind: 'reproduced', reference: 'receipt-2'});
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 0);
});

test('no_change does not count, newly passed checks do, and new binding resets', () => {
  const r = {}, s = state('failed');
  observeAdmission(r, s, input(), 'root');
  observeAdmission(r, s, input(), 'root');
  recordProgress(r, {failureKey: 'test-a', kind: 'no_change', reference: 'r'});
  const advice = observeAdmission(r, s, input(), 'root');
  assert.equal(advice.semanticNoProgressContinuations, 2);
  s.intentEvidence['["root","t"]'].checks.a.status = 'passed';
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 0);
  observeAdmission(r, s, input({intentRevision: 2}), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 0);
});

test('status regression and re-pass are not new progress without evidence', () => {
  const r = {}, s = state();
  observeAdmission(r, s, input(), 'root');
  observeAdmission(r, s, input(), 'root');
  s.intentEvidence['["root","t"]'].checks.a = {status: 'failed'};
  observeAdmission(r, s, input(), 'root');
  s.intentEvidence['["root","t"]'].checks.a = {status: 'passed'};
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 3);
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 4);
});

test('evidence normalization rejects unknown or oversized fields and bounds history', () => {
  assert.equal(progressEvidenceSchema.additionalProperties, false);
  assert.throws(() => normalizeProgressEvidence({failureKey: 'x', kind: 'no_change', reference: 'r', extra: 1}));
  assert.throws(() => normalizeProgressEvidence({failureKey: 'x'.repeat(129), kind: 'no_change', reference: 'r'}));
  assert.throws(() => normalizeProgressEvidence({failureKey: 'x', kind: 'no_change', reference: 'r'.repeat(501)}));
  for (const value of ['', '   ', '\n', 'bad\nvalue', 'bad\0value']) {
    assert.throws(() => normalizeProgressEvidence({failureKey: value, kind: 'no_change', reference: 'r'}));
    assert.throws(() => normalizeProgressEvidence({failureKey: 'x', kind: 'no_change', reference: value}));
  }
  assert.deepEqual(normalizeProgressEvidence({failureKey: '  key ', kind: 'no_change', reference: ' ref '}), {failureKey: 'key', kind: 'no_change', reference: 'ref'});
  const r = {};
  for (let n = 0; n < 40; n++) recordProgress(r, {failureKey: `f${n}`, kind: 'no_change', reference: `r${n}`});
  assert.equal(r.convergence.progress.evidenceDigests.length, 32);
});

test('old convergence registry migrates without treating raw admissions as semantic progress', () => {
  const r = {convergence: {fingerprint: 'legacy', admissions: 3}}, s = state();
  observeAdmission(r, s, input(), 'root');
  assert.equal(r.convergence.progress.noProgressContinuations, 0);
  assert.equal(r.convergence.admissions, 1);
});

test('user action filtering remains compatible', () => {
  assert.deepEqual(userActions([{intentRevision: 2, attention: {intentRevision: 1, progressState: 'needs_user_action'}}], 2), []);
  assert.equal(convergenceAdvice({convergence: {admissions: 2}}), undefined);
});

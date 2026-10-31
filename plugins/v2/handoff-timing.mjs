// Passive generation-bound timing. No timers, inference, admission decisions or
// status-side writes. An accepted continuation is not proof of model execution.
const LIMIT = 16;
const timestamp = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;
const elapsed = (start, end) => timestamp(start) && timestamp(end) && end >= start ? end - start : null;
const fields = ['generation', 'childID', 'admittedAt', 'acceptedAt', 'completedAt', 'collectedAt', 'continuationAcceptedAt', 'continuationGeneration'];
const rows = record => Array.isArray(record.handoffTimings) ? record.handoffTimings.filter(row => row && typeof row === 'object' && Number.isSafeInteger(row.generation) && row.generation > 0) : [];

export function beginHandoffTiming(record, generation, at) {
  record.handoffTimings = [...rows(record).filter(row => row.generation !== generation), {generation, admittedAt:timestamp(at)}].slice(-LIMIT);
}
export function acceptHandoffTiming(record, generation, childID, at) {
  const history = rows(record), current = history.find(row => row.generation === generation);
  if (!current || !timestamp(at)) return;
  current.childID = childID;
  current.acceptedAt ??= at;
  const previous = history.filter(row => row.generation < generation && row.childID === childID && timestamp(row.acceptedAt)).at(-1);
  if (previous && previous.continuationAcceptedAt === undefined) {
    previous.continuationAcceptedAt = at;
    previous.continuationGeneration = generation;
  }
}
export function collectHandoffTiming(record, receipt, at) {
  const current = rows(record).find(row => row.generation === receipt.generation && row.childID === record.childID);
  if (!current) return; // No invented migration timestamps for legacy records.
  current.completedAt ??= timestamp(receipt.completedAt);
  current.collectedAt ??= timestamp(at);
}
export function handoffTimingStatus(record) {
  return {
    basis:'native_acceptance_and_exact_background_receipt',
    generations:rows(record).slice(-LIMIT).map(row => ({
      ...Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key, row[key]])),
      completionToCollectionMs:elapsed(row.completedAt, row.collectedAt),
      collectionToContinuationMs:elapsed(row.collectedAt, row.continuationAcceptedAt),
      completionToContinuationMs:elapsed(row.completedAt, row.continuationAcceptedAt),
    })),
  };
}

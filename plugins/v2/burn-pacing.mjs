// r20 item 4: trailing burn-rate guard for weekly (>= 7 day) quota windows.
// Records used_percent samples per window (provider + duration + reset) as quota snapshots are
// seen and reports "ahead" when the trailing burn over the last ~3h exceeds the sustainable rate
// to the reset ((100 - used) / hours left). quotaPace folds this into its existing "ahead"
// pace, which drives the existing pace demotion. Observer only: it never blocks a dispatch.
const WEEK_MINUTES = 10080;
const TRAIL_MS = 3 * 3600_000, MIN_SPAN_MS = 30 * 60_000, MAX_WINDOWS = 64, MAX_SAMPLES = 64;
const samples = new Map(); // windowKey -> [{at, used}]

const ms = value => typeof value === 'number' ? (value > 1e12 ? value : value * 1000) : Date.parse(value);

export function windowBurn(provider, window, now = Date.now(), store = samples) {
  const used = window?.used_percent, duration = window?.duration_minutes, resets = ms(window?.resets_at);
  if (!Number.isFinite(used) || !Number.isFinite(duration) || duration < WEEK_MINUTES || !Number.isFinite(resets) || resets <= now) return undefined;
  const key = `${provider}\0${window.scope ?? ''}\0${duration}\0${resets}`;
  let list = store.get(key);
  if (!list) { if (store.size >= MAX_WINDOWS) store.delete(store.keys().next().value); list = []; store.set(key, list); }
  if (!list.length || list.at(-1).at < now) list.push({ at: now, used });
  while (list.length && (list[0].at < now - TRAIL_MS || list.length > MAX_SAMPLES)) list.shift();
  const first = list[0], span = now - first.at;
  if (list.length < 2 || span < MIN_SPAN_MS) return undefined;
  const ratePerHour = Math.max(0, used - first.used) / (span / 3600_000);
  const sustainablePerHour = Math.max(0, 100 - used) / ((resets - now) / 3600_000);
  return { ratePerHour, sustainablePerHour, ahead: ratePerHour > sustainablePerHour };
}

export function burnAhead(provider, windows, now = Date.now(), store = samples) {
  let ahead = false;
  for (const window of windows ?? []) if (windowBurn(provider, window, now, store)?.ahead) ahead = true;
  return ahead;
}
export const resetBurnSamples = () => samples.clear();

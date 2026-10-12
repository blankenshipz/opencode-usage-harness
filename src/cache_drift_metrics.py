"""Read bounded metadata-only prepared-context observations, never prompt bodies."""
import json
import math
from collections import Counter
from pathlib import Path


def cache_drift_metrics(file, *, session_ids, cutoff_ms, now_ms):
    reasons, dimensions = Counter(), Counter()
    overhead = 0.0
    invalid = dropped = 0
    available = False
    limited = False
    for file in (Path(file).with_name(Path(file).name + '.1'), Path(file)):
        try:
            if file.is_symlink():
                raise ValueError('unsafe telemetry')
            with file.open('rb') as stream:
                available = True
                size = file.stat().st_size
                if size > 16 * 1024 * 1024:
                    stream.seek(size - 16 * 1024 * 1024)
                    stream.readline()
                    limited = True
                for raw in stream:
                    if len(raw) > 4096:
                        invalid += 1
                        continue
                    try:
                        item = json.loads(raw)
                        if not isinstance(item, dict):
                            raise ValueError('invalid observation')
                        if item.get('session_id') not in session_ids or not cutoff_ms <= item['created_ms'] <= now_ms:
                            continue
                        reason = item['reason']
                        if reason not in {'baseline', 'compaction_boundary', 'route_changed', 'history_shortened', 'stable', 'drift_observed', 'observation_unavailable'}:
                            raise ValueError('unknown observation')
                        duration = item['processing_ms']
                        axes = item.get('dimensions', [])
                        if not isinstance(duration, (int,float)) or not math.isfinite(duration) or duration < 0 or not isinstance(axes,list) or any(x not in {'system','tools','early_messages'} for x in axes):
                            raise ValueError('invalid observation')
                        reasons[reason] += 1; dimensions.update(axes); overhead += duration
                        loss = item.get('observer_dropped',0)
                        if isinstance(loss,int) and loss >= 0:
                            dropped += loss
                    except (ValueError, KeyError, TypeError):
                        invalid += 1
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            invalid += 1
    return {'status': 'observed' if reasons else 'no_observations' if available else 'unavailable',
            'observations':sum(reasons.values()), 'reasons':dict(reasons), 'changed_dimensions':dict(dimensions),
            'processing_ms':overhead, 'observer_dropped_reported':dropped, 'invalid_records':invalid,
            'history_limited':limited, 'retention':'current and previous bounded segment only',
            'scope':'prepared shared context, not final wire bytes; changes are not proven cache misses or savings'}

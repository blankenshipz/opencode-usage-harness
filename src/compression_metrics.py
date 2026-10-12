"""Metadata-only accounting for prepared local tool-output projections."""
import json
from collections import Counter
from pathlib import Path


def compression_metrics(directory, *, session_ids, cutoff_ms, now_ms):
    count = before = after = invalid = 0
    strategies = Counter()
    skipped = Counter()
    overhead_ms = overhead_events = retrievals = invalid_diagnostics = 0
    diagnostic_files = diagnostic_events = 0
    # Never open original.txt or chunks.jsonl. No provider-dollar estimates.
    for file in list(Path(directory).glob('*/metadata.json'))[:256]:
        try:
            if file.is_symlink() or file.parent.is_symlink() or file.stat().st_size > 4096:
                raise ValueError('invalid metadata file')
            data = json.loads(file.read_text())
            if not isinstance(data, dict):
                raise ValueError('invalid metadata object')
            if data.get('session_id') not in session_ids:
                continue
            if not cutoff_ms <= data['created_ms'] <= now_ms:
                continue
            a, b = data['original_chars'], data['projected_chars']
            if not isinstance(a, int) or not isinstance(b, int) or not 0 < b < a <= 1024 * 1024:
                raise ValueError('invalid character counts')
            if data['strategy'] not in {'json-whitespace', 'json-table', 'path-prefix', 'exact-repeat-lines', 'diff-context-preview'}:
                raise ValueError('invalid strategy')
            count += 1; before += a; after += b; strategies[data['strategy']] += 1
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            invalid += 1
    # Diagnostics are a separate best-effort stream. They never contain tool
    # content, prompts, paths, or provider/model routing data. Prepared-result
    # counts above remain metadata-store truth; this stream adds skip/retrieval
    # coverage and local processing overhead only.
    telemetry = Path(directory).parent / 'telemetry' / 'compression-diagnostics.jsonl'
    # Keep one rotated predecessor so routine traffic does not permanently
    # suppress diagnostics after a file fills. Older events are intentionally
    # outside the bounded retention window.
    for diagnostic_file in (telemetry.with_name(telemetry.name + '.1'), telemetry):
        try:
            if diagnostic_file.is_symlink() or diagnostic_file.stat().st_size > 2 * 1024 * 1024 + 65536:
                raise ValueError('invalid diagnostics file')
            with diagnostic_file.open(encoding='utf8') as records:
                diagnostic_files += 1
                for line in records:
                    try:
                        data = json.loads(line)
                        if not isinstance(data, dict) or data.get('version') != 1:
                            raise ValueError('invalid diagnostics record')
                        if data.get('session_id') not in session_ids:
                            continue
                        created = data.get('created_ms')
                        if not isinstance(created, int) or not cutoff_ms <= created <= now_ms:
                            continue
                        event_type = data.get('type')
                        if event_type == 'native_original_retrieval':
                            retrievals += 1
                        elif event_type == 'candidate':
                            reason = data.get('reason')
                            if not isinstance(reason, str) or len(reason) > 80:
                                raise ValueError('invalid diagnostics reason')
                            if reason != 'prepared':
                                skipped[reason] += 1
                            processing = data.get('processing_ms')
                            if processing is not None:
                                if not isinstance(processing, int) or not 0 <= processing <= 600000:
                                    raise ValueError('invalid processing time')
                                overhead_ms += processing
                                overhead_events += 1
                        else:
                            raise ValueError('invalid diagnostics event')
                        diagnostic_events += 1
                    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
                        invalid_diagnostics += 1
        except FileNotFoundError:
            pass
        except (OSError, ValueError):
            invalid_diagnostics += 1
    return {'prepared_results': count, 'original_chars': before, 'projected_chars': after,
            'reduced_chars': before - after, 'strategies': dict(strategies), 'invalid_records': invalid,
            'diagnostics_status': 'observed' if diagnostic_events else 'no_observations' if diagnostic_files else 'unavailable',
            'skipped_reasons': dict(skipped),
            'processing_overhead_ms': {'total': overhead_ms, 'events': overhead_events,
                                       'average': overhead_ms / overhead_events if overhead_events else None},
            'native_original_retrievals': retrievals,
            'token_estimate': {'status': 'unavailable', 'reason': 'no-model-specific-tokenizer'},
            'invalid_diagnostic_records': invalid_diagnostics,
            'diagnostics_retention': 'current-and-one-rotated-file',
            'scope': 'prepared projections before native truncation; diagnostics are local overhead and native retrieval observations only; token, credit, and dollar savings unavailable'}

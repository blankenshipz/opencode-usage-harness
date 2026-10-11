"""Metadata-only accounting for prepared local tool-output projections."""
import json
from collections import Counter
from pathlib import Path


def compression_metrics(directory, *, session_ids, cutoff_ms, now_ms):
    count = before = after = invalid = 0
    strategies = Counter()
    # Never open original.txt or chunks.jsonl. No provider-dollar estimates.
    for file in list(Path(directory).glob('*/metadata.json'))[:256]:
        try:
            if file.is_symlink() or file.parent.is_symlink() or file.stat().st_size > 4096:
                raise ValueError('invalid metadata file')
            data = json.loads(file.read_text())
            if data.get('session_id') not in session_ids:
                continue
            if not cutoff_ms <= data['created_ms'] <= now_ms:
                continue
            a, b = data['original_chars'], data['projected_chars']
            if not isinstance(a, int) or not isinstance(b, int) or not 0 < b < a <= 1024 * 1024:
                raise ValueError('invalid character counts')
            if data['strategy'] not in {'json-whitespace', 'json-table', 'path-prefix', 'exact-repeat-lines'}:
                raise ValueError('invalid strategy')
            count += 1; before += a; after += b; strategies[data['strategy']] += 1
        except (OSError, ValueError, KeyError, TypeError):
            invalid += 1
    return {'prepared_results': count, 'original_chars': before, 'projected_chars': after,
            'reduced_chars': before - after, 'strategies': dict(strategies), 'invalid_records': invalid,
            'scope': 'prepared projections before native truncation; not verified token, credit, or dollar savings'}

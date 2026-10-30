import json
import tempfile
import unittest
from pathlib import Path
from src.compression_metrics import compression_metrics

class CompressionMetricsTest(unittest.TestCase):
    def test_metadata_only_scoped_and_corruption_tolerant(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name, session, created in [('one', 's', 50), ('other', 'else', 50), ('old', 's', 1)]:
                folder=root/name; folder.mkdir()
                (folder/'metadata.json').write_text(json.dumps({'session_id':session,'created_ms':created,'strategy':'json-table','original_chars':9000,'projected_chars':2000}))
                (folder/'original.txt').write_bytes(b'not read\xff')
            bad=root/'bad';bad.mkdir();(bad/'metadata.json').write_text('bad')
            result=compression_metrics(root,session_ids={'s'},cutoff_ms=10,now_ms=100)
            self.assertEqual(result['prepared_results'],1)
            self.assertEqual(result['reduced_chars'],7000)
            self.assertEqual(result['invalid_records'],1)
            self.assertEqual(result['native_original_retrievals'], 0)
            self.assertEqual(result['diagnostics_status'], 'unavailable')
            self.assertEqual(result['token_estimate']['status'], 'unavailable')

    def test_aggregates_bounded_metadata_only_diagnostics(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'tool-output-store'; root.mkdir()
            telemetry = root.parent / 'telemetry'; telemetry.mkdir()
            records = [
                {'version': 1, 'type': 'candidate', 'session_id': 's', 'created_ms': 50,
                 'reason': 'protected_tool', 'processing_ms': 4, 'original_chars': 7000,
                 'token_estimate': {'status': 'unavailable', 'reason': 'no-model-specific-tokenizer'}},
                {'version': 1, 'type': 'candidate', 'session_id': 's', 'created_ms': 60,
                 'reason': 'prepared', 'processing_ms': 6,
                 'token_estimate': {'status': 'unavailable', 'reason': 'no-model-specific-tokenizer'}},
                {'version': 1, 'type': 'native_original_retrieval', 'session_id': 's', 'created_ms': 70,
                 'token_estimate': {'status': 'unavailable', 'reason': 'no-model-specific-tokenizer'}},
                {'version': 1, 'type': 'candidate', 'session_id': 'other', 'created_ms': 50,
                 'reason': 'unsupported_tool', 'processing_ms': 9},
                'not-json',
            ]
            (telemetry / 'compression-diagnostics.jsonl').write_text('\n'.join(
                item if isinstance(item, str) else json.dumps(item) for item in records))
            result = compression_metrics(root, session_ids={'s'}, cutoff_ms=10, now_ms=100)
            self.assertEqual(result['skipped_reasons'], {'protected_tool': 1})
            self.assertEqual(result['skipped_observed_chars'], {'protected_tool': 7000})
            self.assertEqual(result['savings_status'], 'no_observed_savings')
            self.assertEqual(result['processing_overhead_ms'], {'total': 10, 'events': 2, 'average': 5})
            self.assertEqual(result['native_original_retrievals'], 1)
            self.assertEqual(result['diagnostics_status'], 'observed')
            self.assertEqual(result['invalid_diagnostic_records'], 1)

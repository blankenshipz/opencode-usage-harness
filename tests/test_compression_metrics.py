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

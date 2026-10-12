import json
import tempfile
import unittest
from pathlib import Path
from src.cache_drift_metrics import cache_drift_metrics

class CacheMetricsTests(unittest.TestCase):
    def test_scoped_metadata_and_missing_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'observations.jsonl'
            args=dict(session_ids={'s'},cutoff_ms=20,now_ms=100)
            self.assertEqual(cache_drift_metrics(p,**args)['status'],'unavailable')
            records=[dict(session_id=s,created_ms=t,reason='drift_observed',dimensions=['tools'],processing_ms=1.5) for s,t in [('s',50),('other',50),('s',1)]]
            p.write_text('\n'.join(map(json.dumps,records))+'\ninvalid\n')
            result=cache_drift_metrics(p,**args)
            self.assertEqual(result['observations'],1)
            self.assertEqual(result['changed_dimensions'],{'tools':1})
            self.assertEqual(result['processing_ms'],1.5)
            self.assertEqual(result['invalid_records'],1)

    def test_previous_segment_is_included(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'events.jsonl'
            event=dict(session_id='s',created_ms=50,reason='stable',dimensions=[],processing_ms=1)
            p.write_text(json.dumps(event)+'\n')
            p.with_name(p.name+'.1').write_text(json.dumps(event)+'\n')
            self.assertEqual(cache_drift_metrics(p,session_ids={'s'},cutoff_ms=20,now_ms=100)['observations'],2)

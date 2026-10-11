import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from src.check_receipt import preview_log

ROOT = Path(__file__).resolve().parents[1]

class CheckPreviewTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'HARNESS_STATE_DIR': str(self.state)})
        self.env.start(); self.addCleanup(self.env.stop)
        self.run = self.state / 'check-receipts' / 'fixture'
        self.run.mkdir(parents=True)
        self.receipt = self.run / 'receipt.json'
        self.receipt.write_text(json.dumps({'outcome': 'failed', 'exit_code': 3, 'stderr_file': 'stderr.log'}))
        self.log = self.run / 'stderr.log'

    def test_compaction_preserves_original_failure_and_page_boundaries(self):
        original = ('repeated detailed warning: do not overlook the failure below\n' * 130 + 'ERROR 41 distinct\nERROR 42 distinct\n').encode()
        self.log.write_bytes(original)
        first = preview_log(self.receipt, limit=120)
        self.assertEqual(first['duplicate_lines_collapsed'], 119)
        self.assertEqual(first['next_offset'], 121)
        second = preview_log(self.receipt, offset=first['next_offset'])
        self.assertIn('ERROR 41 distinct\nERROR 42 distinct', second['text'])
        self.assertIsNone(second['next_offset'])
        self.assertEqual(self.log.read_bytes(), original)
        self.assertEqual(json.loads(self.receipt.read_text())['exit_code'], 3)
        self.assertNotIn('tokens_saved', first)

    def test_budget_returns_next_page_without_dropping_distinct_lines(self):
        lines = [f'{n}: ' + 'x'*1000 + '\n' for n in range(100)]
        self.log.write_text(''.join(lines))
        page = preview_log(self.receipt, limit=350)
        self.assertLessEqual(len(json.dumps(page).encode()),32768)
        self.assertEqual(page['text'], ''.join(lines[:page['lines_read']]))
        self.assertEqual(page['next_offset'],page['lines_read']+1)

    def test_unsafe_or_unavailable_sources_fail_without_preview(self):
        self.log.write_text('safe\n')
        for offset,limit in [(0,120),(1,351),(1,0)]:
            with self.assertRaises(ValueError): preview_log(self.receipt, offset=offset,limit=limit)
        self.receipt.write_text(json.dumps({'outcome':'running','stderr_file':'stderr.log'}))
        with self.assertRaises(ValueError): preview_log(self.receipt)
        self.receipt.write_text(json.dumps({'outcome':'failed','stderr_file':'../../secret'}))
        with self.assertRaises(ValueError): preview_log(self.receipt)
        self.receipt.write_text(json.dumps({'outcome':'failed','stderr_file':'stderr.log'}))
        self.log.unlink(); outside=self.state/'outside';outside.write_text('private')
        self.log.symlink_to(outside)
        with self.assertRaises(ValueError): preview_log(self.receipt)

    def test_binary_and_oversized_lines_are_not_silently_rewritten(self):
        for body in (b'\xff\xfe', b'x'*65537):
            self.log.write_bytes(body)
            with self.assertRaises(ValueError): preview_log(self.receipt)

    def test_cli_never_executes_trailing_command(self):
        self.log.write_text('failure\n')
        marker=self.state/'must-not-exist'
        result=subprocess.run([sys.executable,str(ROOT/'bin/harness-check'),'--preview',str(self.receipt),'--',sys.executable,'-c',f'open({str(marker)!r},"w").close()'],capture_output=True,text=True)
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(marker.exists())
        good=subprocess.run([sys.executable,str(ROOT/'bin/harness-check'),'--preview',str(self.receipt)],capture_output=True,text=True)
        self.assertEqual(good.returncode,0,good.stderr)
        self.assertEqual(json.loads(good.stdout)['text'],'failure\n')

    def test_scan_budget_is_a_hard_read_ceiling(self):
        self.log.write_bytes((b'x'*63+b'\n') * 65538)
        original = os.fdopen
        measured = [0]
        class Counted:
            def __init__(self, handle): self.handle=handle
            def __enter__(self): return self
            def __exit__(self,*args): self.handle.close()
            def fileno(self): return self.handle.fileno()
            def readline(self,n):
                value=self.handle.readline(n); measured[0]+=len(value);return value
            def read(self,n):
                value=self.handle.read(n); measured[0]+=len(value);return value
        with patch('src.check_receipt.os.fdopen',side_effect=lambda *a,**k:Counted(original(*a,**k))):
            with self.assertRaises(ValueError): preview_log(self.receipt,offset=65537)
        self.assertLessEqual(measured[0],4*1024*1024)

if __name__ == '__main__': unittest.main()

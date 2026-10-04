import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('adapter',Path(__file__).resolve().parents[1]/'integrations/openchamber/install-progress.py')
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)
class AdapterTests(unittest.TestCase):
 def test_auth_untouched_and_overlay_precedes_generic_proxy(self):
  src="const fetchSessionListPayload = async () => {};\nAUTH_GATE();\n      const scheduleHeartbeat = () => {\n          const canContinue = await enqueueSseWrite(':heartbeat\\n\\n');\n};\n  // Generic proxy for non-SSE OpenCode API routes.\nPROXY();"
  result=adapter.patch(src,'file:///safe/module.mjs',Path('/safe/snapshots'))
  self.assertLess(result.index('AUTH_GATE()'),result.index('app.get('))
  self.assertLess(result.index('hydrateProgress(result.payload'),result.index('PROXY()'))
  self.assertIn('if (!result.upstream.ok',result)
  with self.assertRaises(ValueError):adapter.patch(result,'file:///safe/module.mjs',Path('/safe/snapshots'))
 def test_unknown_layout_rejected(self):
  with self.assertRaises(ValueError):adapter.patch('unknown','file:///safe/module.mjs',Path('/safe/snapshots'))

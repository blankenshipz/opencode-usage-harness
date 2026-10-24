import contextlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('public_audit', Path(__file__).resolve().parents[1] / 'scripts/audit_public.py')
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


class PublicAuditTests(unittest.TestCase):
    def run_audit(self, root):
        original = AUDIT.ROOT
        try:
            AUDIT.ROOT = root
            with contextlib.redirect_stdout(io.StringIO()):
                return AUDIT.audit()
        finally:
            AUDIT.ROOT = original

    def test_regular_attributes_are_scanned_not_skipped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attributes = root / '.gitattributes'
            attributes.write_text('*.patch -whitespace\n')
            self.assertFalse(self.run_audit(root))
            attributes.write_text('/' + 'Users/' + 'fixture/private-location\n')
            self.assertTrue(self.run_audit(root))

    def test_attributes_symlink_and_nested_directory_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('fixture\n')
            attributes = root / '.gitattributes'
            attributes.symlink_to(root / 'README.md')
            self.assertTrue(self.run_audit(root))
            attributes.unlink()
            attributes.mkdir()
            (attributes / 'unexpected').write_text('fixture\n')
            self.assertTrue(self.run_audit(root))

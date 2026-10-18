"""Guard against accidental private attachments and stale media approvals."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from check_public_tree import scan_files


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def approve(self, name, data):
        self.write('docs/archive-assets.json', json.dumps({'version': 1, 'assets': [{'path': name, 'sha256': hashlib.sha256(data).hexdigest()}]}).encode())

    def test_new_screenshot_is_rejected_without_review(self):
        name = 'docs/presentation/assets/new.png'
        self.write(name, b'\x89PNG\0synthetic')
        self.assertIn((name, 'unexpected-image'), scan_files(self.root, [name]))

    def test_modified_approved_image_is_rejected(self):
        name, content = 'docs/presentation/assets/product.png', b'\x89PNG\0synthetic'
        self.approve(name, content)
        self.write(name, content)
        self.assertEqual([], scan_files(self.root, [name]))
        self.write(name, content + b'changed')
        self.assertIn((name, 'archive-hash-mismatch'), scan_files(self.root, [name]))

    def test_manifest_cannot_approve_a_private_key_or_database(self):
        for name in ('octop/private/key.bin', 'docs/presentation/family.sqlite'):
            self.approve(name, b'private')
            self.write(name, b'private')
            self.assertTrue(scan_files(self.root, [name]))

    def test_complete_monitor_credential_in_text_is_rejected(self):
        name = 'docs/example.md'
        self.write(name, ('da_' + 'a' * 43).encode())
        self.assertIn((name, 'application-token'), scan_files(self.root, [name]))


if __name__ == '__main__':
    unittest.main()

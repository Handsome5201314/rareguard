"""Package only release files; verify ZIP via an isolated real Octop installer."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import tempfile
from unittest.mock import patch
import zipfile

from octop.infra.agents.plugins.manager import PluginManager
from octop_harness.plugins.tools import build_plugin_tools

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'plugins' / 'family-medical-plugin'
OUTPUT = ROOT / 'plugins' / 'dist' / 'family-medical-plugin-0.1.0.zip'
FILES = ('plugin.yaml', 'main.py', 'client.py', 'storage.py', 'requirements.txt', 'README.md')


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        path = SOURCE / name
        assert path.is_file() and not path.is_symlink(), 'Release input missing or linked: ' + name
        data = path.read_bytes()
        assert not re.search(rb'family_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])', data), 'Credential found in ' + name
        assert (b'-----BEGIN ' + b'PRIVATE KEY-----') not in data, 'Private key found in ' + name
    with zipfile.ZipFile(OUTPUT, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name in FILES:
            archive.write(SOURCE / name, 'family-medical-plugin/' + name)
    with zipfile.ZipFile(OUTPUT) as archive:
        assert archive.testzip() is None, 'ZIP CRC mismatch'
        assert set(archive.namelist()) == {'family-medical-plugin/' + name for name in FILES}
        for name in archive.namelist():
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
    with tempfile.TemporaryDirectory(prefix='octop-family-zip-check-') as directory:
        test_root = Path(directory)
        manager = PluginManager(plugins_dir=test_root / 'plugins', config_path=test_root / 'config.json')
        # Test the actual archive installer without pip-changing the user's Octop runtime.
        with patch('octop_harness.plugins.loader._install_requires') as dependencies:
            installed = manager.install_archive(OUTPUT)
            assert dependencies.call_count == 1
        assert installed.manifest.id == 'family-medical-plugin'
        assert installed.manifest.version == '0.1.0'
        tools = [tool for tool in build_plugin_tools() if tool.name.startswith('bingcheng_')]
        assert len(tools) == 6
        for tool in tools:
            json.dumps(tool.args_schema.model_json_schema())
            assert 'state' not in tool.tool_call_schema.model_json_schema().get('properties', {})
        assert not (test_root / 'config.json').exists(), 'Installer unexpectedly changed settings'
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    OUTPUT.with_suffix('.zip.sha256').write_text(digest + '  ' + OUTPUT.name + '\n', encoding='ascii')
    print(json.dumps({'zip': str(OUTPUT), 'bytes': OUTPUT.stat().st_size, 'sha256': digest,
                      'files': len(FILES), 'tools': len(tools), 'archiveInstaller': 'passed',
                      'dependencyInstall': 'skipped; installed runtime dependencies used'}, ensure_ascii=False))


if __name__ == '__main__': build()

"""Check publication paths and text without printing matched private contents."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

bad_suffixes = {'.pem', '.key', '.pub', '.p12', '.pfx', '.jks', '.keystore', '.db',
                '.sqlite', '.sqlite3', '.csv', '.log', '.har', '.pcap', '.pcapng', '.apk', '.aab'}
bad_parts = {'.venv', '.dart_tool', '.gradle', '__pycache__', '.pytest_cache', 'build',
             'node_modules', 'dist', 'family-data', 'family-test-data', 'private', 'references',
             'runtime', '.archive-build', 'agent-runtime', 'exports', 'captures', 'screenshots', '.impeccable', 'ectri-reverse', 'jadx', 'apktool'}
patterns = {
    'application-token': re.compile(r'\b(?:family_|da_|dd_|dp_)[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])'),
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'api-token': re.compile(r'\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b'),
    'cloud-access-key': re.compile(r'\b(?:AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b'),
    'personal-path': re.compile(r'(?:[A-Za-z]:[\\/]Users[\\/](?!Public[\\/])[^\s"\'<>]+|E:[\\/]AI新青年)'),
    'device-address': re.compile(r'\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b'),
}
def approved_assets(root):
    manifest = root / 'docs/archive-assets.json'
    if not manifest.exists():
        return {}
    document = json.loads(manifest.read_text(encoding='utf-8'))
    if document.get('version') != 1:
        raise ValueError('unsupported-archive-manifest')
    approved = {}
    for entry in document['assets']:
        name, digest = entry['path'], entry['sha256']
        path = PurePosixPath(name)
        allowed = name.startswith('docs/presentation/') or name == 'octop/dravet-monitor-plugin-0.1.0.zip'
        if not allowed or path.is_absolute() or '..' in path.parts or name in approved or not re.fullmatch('[0-9a-f]{64}', digest):
            raise ValueError('invalid-archive-approval')
        if path.suffix not in {'.png', '.jpg', '.jpeg', '.pdf', '.pptx', '.zip'}:
            raise ValueError('invalid-archive-type')
        approved[name] = digest
    return approved


def scan_files(root, paths):
    findings = []
    try:
        approved = approved_assets(root)
    except (KeyError, TypeError, ValueError):
        return [('docs/archive-assets.json', 'invalid-archive-manifest')]
    for name in paths:
        path = Path(name)
        if any(part in bad_parts for part in path.parts) or path.suffix.lower() in bad_suffixes or path.name == 'key.bin':
            findings.append((name, 'private-or-generated-file'))
            continue
        if path.name in {'local.properties', 'key.properties'} or (path.name.startswith('.env') and path.name != '.env.example'):
            findings.append((name, 'private-configuration'))
            continue
        if name in approved:
            if hashlib.sha256((root / path).read_bytes()).hexdigest() != approved[name]:
                findings.append((name, 'archive-hash-mismatch'))
            continue
        if path.suffix.lower() in {'.png', '.jpg', '.jpeg', '.webp'}:
            if not (name.startswith('app/assets/images/') or name.startswith('app/android/app/src/main/res/')):
                findings.append((name, 'unexpected-image'))
            continue
        if path.suffix.lower() == '.jar':
            if name != 'app/android/gradle/wrapper/gradle-wrapper.jar':
                findings.append((name, 'unexpected-binary'))
            continue
        data = (root / path).read_bytes()
        if b'\0' in data:
            findings.append((name, 'unexpected-binary'))
            continue
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            findings.append((name, 'non-utf8-text'))
            continue
        for category, pattern in patterns.items():
            if pattern.search(text):
                findings.append((name, category))
    return findings


def main():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
    paths = [name for name in result.stdout.decode('utf-8').split('\0') if name]
    if not paths:
        raise SystemExit('No tracked files: stage the source tree before checking it')
    findings = scan_files(root, paths)
    if findings:
        for name, category in findings:
            print(f'{name}: {category}')
        return 1
    print(f'Publication file checks passed: {len(paths)} tracked files')
    return 0


if __name__ == '__main__':
    sys.exit(main())

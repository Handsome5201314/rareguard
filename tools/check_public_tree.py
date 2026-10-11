"""Check tracked publication files without printing matched private contents."""
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
result = subprocess.run(['git', 'ls-files', '-z'], cwd=root, check=True, capture_output=True)
paths = [p for p in result.stdout.decode('utf-8').split('\0') if p]
if not paths:
    raise SystemExit('No tracked files: stage the source tree before checking it')

bad_suffixes = {'.pem', '.key', '.pub', '.p12', '.pfx', '.jks', '.keystore', '.db',
                '.sqlite', '.sqlite3', '.csv', '.log', '.har', '.pcap', '.pcapng', '.apk', '.aab'}
bad_parts = {'.venv', '.dart_tool', '.gradle', '__pycache__', '.pytest_cache', 'build',
             'runtime', 'exports', 'captures', 'screenshots', '.impeccable', 'ectri-reverse', 'jadx', 'apktool'}
patterns = {
    'private-key': re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b'),
    'api-token': re.compile(r'\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b'),
    'cloud-access-key': re.compile(r'\b(?:AKIA[A-Z0-9]{16}|LTAI[A-Za-z0-9]{16,})\b'),
    'personal-path': re.compile(r'(?:[A-Za-z]:[\\/]Users[\\/](?!Public[\\/])[^\s"\'<>]+|E:[\\/]AI新青年)'),
    'device-address': re.compile(r'\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\b'),
}
findings = []
for name in paths:
    path = Path(name)
    if any(part in bad_parts for part in path.parts) or path.suffix.lower() in bad_suffixes:
        findings.append((name, 'private-or-generated-file'))
        continue
    if path.name in {'local.properties', 'key.properties'} or (path.name.startswith('.env') and path.name != '.env.example'):
        findings.append((name, 'private-configuration'))
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
    text = data.decode('utf-8-sig')
    for category, pattern in patterns.items():
        if pattern.search(text):
            findings.append((name, category))
if findings:
    for name, category in findings:
        print(f'{name}: {category}')
    sys.exit(1)
print(f'Publication file checks passed: {len(paths)} tracked files')

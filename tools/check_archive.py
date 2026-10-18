"""Verify public document containers and that the plugin ZIP matches its sources."""
import ast
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct
import subprocess
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from pypdf import PdfReader

from check_public_tree import approved_assets, patterns

ROOT = Path(__file__).resolve().parents[1]
DECK = ROOT / 'docs/presentation'


def check_text(text, name):
    for category, pattern in patterns.items():
        if pattern.search(text):
            raise ValueError(f'{name}: {category}')


class Sources(HTMLParser):
    def __init__(self):
        super().__init__()
        self.images = set()

    def handle_starttag(self, tag, attributes):
        for key, value in attributes:
            if tag == 'img' and key == 'src':
                if not value.startswith('assets/') or '..' in Path(value).parts:
                    raise ValueError('Unexpected HTML image source')
                self.images.add(value)


def main():
    tracked = set(subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, check=True, capture_output=True).stdout.decode().split('\0'))
    for name, digest in approved_assets(ROOT).items():
        if name not in tracked or hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f'{name}: untracked or changed approved asset')
    parser = Sources()
    parser.feed((DECK / 'index.html').read_text(encoding='utf-8'))
    for image in parser.images:
        if f'docs/presentation/{image}' not in approved_assets(ROOT):
            raise ValueError(f'{image}: image not reviewed')
    product = (DECK / 'assets/octop-agent-live.png').read_bytes()
    if product[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', product[16:24]) != (1528, 590):
        raise ValueError('Octop product capture must exclude the original bottom account region')
    for variant, ratio in (('16x9', 16 / 9), ('wide', 15.3 / 5.3)):
        pdf = PdfReader(DECK / f'RareGuard-Dravet-{variant}.pdf')
        if len(pdf.pages) != 11:
            raise ValueError(f'{variant}: expected 11 PDF pages')
        check_text(str(pdf.metadata), f'{variant} metadata')
        for number, page in enumerate(pdf.pages, 1):
            if abs(float(page.mediabox.width / page.mediabox.height) - ratio) > 0.004:
                raise ValueError(f'{variant}: PDF page ratio mismatch')
            check_text(page.extract_text(), f'{variant} page {number}')
        with ZipFile(DECK / f'RareGuard-Dravet-{variant}.pptx') as archive:
            if archive.testzip():
                raise ValueError('Corrupt PPTX member')
            slides = [name for name in archive.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml', name)]
            if len(slides) != 11:
                raise ValueError(f'{variant}: expected 11 PPTX slides')
            size = ET.fromstring(archive.read('ppt/presentation.xml')).find('{http://schemas.openxmlformats.org/presentationml/2006/main}sldSz')
            if abs(int(size.get('cx')) / int(size.get('cy')) - ratio) > 0.004:
                raise ValueError('PPTX ratio mismatch')
            for name in archive.namelist():
                if '/embeddings/' in name or '/activeX/' in name:
                    raise ValueError('Unexpected embedded object')
                if name.endswith(('.xml', '.rels')):
                    element = ET.fromstring(archive.read(name))
                    check_text(' '.join(element.itertext()), name)
                    for child in element.iter():
                        if child.get('TargetMode') == 'External':
                            raise ValueError('Unexpected external PPTX relationship')
        print(f'{variant}: 11 PDF pages / 11 PPTX slides; dimensions and metadata checked')
    source = ROOT / 'plugins/dravet-monitor-plugin'
    expected = {'README.md', 'client.py', 'main.py', 'plugin.yaml', 'requirements.txt', 'storage.py'}
    with ZipFile(ROOT / 'octop/dravet-monitor-plugin-0.1.0.zip') as archive:
        if set(archive.namelist()) != {f'dravet-monitor-plugin/{name}' for name in expected} or len(archive.namelist()) != len(expected):
            raise ValueError('Plugin ZIP contains unexpected or duplicate members')
        for name in expected:
            if archive.read(f'dravet-monitor-plugin/{name}') != (source / name).read_bytes():
                raise ValueError(f'Plugin ZIP differs from source: {name}')
    for path in (ROOT / 'plugins').rglob('*.py'):
        if '__pycache__' not in path.parts:
            ast.parse(path.read_text(encoding='utf-8'), filename=path.name)
    user_template = (ROOT / 'octop/agent-template/USER.md').read_text(encoding='utf-8')
    if '**当前阶段：** `account_ready`' not in user_template or '**称呼：** 待用户设置' not in user_template:
        raise ValueError('User template is not in its initial unconfigured state')
    print(f'Archive verified: {len(parser.images)} reviewed HTML images; source-matching plugin ZIP; initial user template')


if __name__ == '__main__':
    main()

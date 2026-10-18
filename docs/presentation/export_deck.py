"""Render the archived HTML into two PDFs and private PPTX slide images."""
import asyncio
import io
from pathlib import Path

from playwright.async_api import async_playwright
from pypdf import PdfReader, PdfWriter

ROOT = Path(__file__).resolve().parent
BUILD = ROOT.parents[1] / '.archive-build'
VARIANTS = {'16x9': (1920, 1080), 'wide': (2880, 997.647)}


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch()
        try:
            for name, (width, height) in VARIANTS.items():
                images = BUILD / name
                images.mkdir(parents=True, exist_ok=True)
                page = await browser.new_page(viewport={'width': width + 48, 'height': 1128})
                try:
                    await page.goto(ROOT.joinpath('index.html').as_uri() + ('?wide=1' if name == 'wide' else ''), wait_until='networkidle')
                    await page.evaluate('document.fonts.ready')
                    await page.evaluate('Promise.all([...document.images].map(img => img.decode()))')
                    await page.add_style_tag(content='.controls{display:none!important}.slide{transform:none!important;margin:0!important}')
                    slides = page.locator('.slide')
                    if await slides.count() != 11:
                        raise ValueError('Expected 11 source slides')
                    for index in range(11):
                        await slides.nth(index).screenshot(path=str(images / f'{index + 1:02}.png'), animations='disabled')
                    await page.add_style_tag(content='@media print{.deck{display:block!important;padding:0!important;gap:0!important}.slide{break-after:page;page-break-after:always}}')
                    raw_pdf = await page.pdf(width=f'{width}px', height=f'{height}px', print_background=True, margin={'top': '0', 'right': '0', 'bottom': '0', 'left': '0'})
                    reader = PdfReader(io.BytesIO(raw_pdf))
                    if len(reader.pages) != 11:
                        raise ValueError(f'{name}: expected 11 PDF pages, got {len(reader.pages)}')
                    writer = PdfWriter()
                    for source in reader.pages:
                        writer.add_page(source)
                    writer.add_metadata({'/Title': f'RareGuard Dravet {name}', '/Author': 'RareGuard', '/Subject': 'Public product presentation; design examples and synthetic acceptance materials'})
                    destination = ROOT / f'RareGuard-Dravet-{name}.pdf'
                    with destination.open('wb') as output:
                        writer.write(output)
                    print(f'{destination.name}: 11 pages')
                finally:
                    await page.close()
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main())

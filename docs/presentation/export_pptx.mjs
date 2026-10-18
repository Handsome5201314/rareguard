// Rendered-slide drafts. Final PDFs and reviewed PPTX files are archived beside this script.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

const deckDir = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(deckDir, '../../.archive-build');
const variants = { '16x9': [1920, 1080], wide: [2880, 997.647] };
for (const [name, [width, height]] of Object.entries(variants)) {
  const presentation = Presentation.create({ slideSize: { width, height } });
  for (let number = 1; number <= 11; number++) {
    const slide = presentation.slides.add();
    const bytes = await fs.readFile(path.join(buildDir, name, `${String(number).padStart(2, '0')}.png`));
    slide.images.add({ blob: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      contentType: 'image/png', alt: `RareGuard ${name} slide ${number}`, fit: 'contain', geometry: 'rect',
      position: { left: 0, top: 0, width, height } });
    slide.speakerNotes.text = 'Source: docs/presentation/index.html. App UI is a design example; cloud pages contain synthetic acceptance data. Octop image excludes the account region. Real device, overnight coverage and alarm acceptance remain pending. Edit HTML to change content; this PPTX uses rendered slide images.';
  }
  const output = path.join(buildDir, `RareGuard-Dravet-${name}.pptx`);
  await (await PresentationFile.exportPptx(presentation)).save(output);
  console.log(JSON.stringify({ draft: path.basename(output), slides: 11 }));
}

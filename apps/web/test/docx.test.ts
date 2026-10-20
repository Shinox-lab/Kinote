// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import { zip } from '../../../e2e/fixtures.js';
import { docxToHtml } from '../src/viewers/docx.js';

// A Word file with pictures is common. The preview shows its text; pictures are not shown, and must never be
// inlined as base64 (a few megabytes of photos would push the markup past the size limit and lose the whole preview).

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function docxWithPicture(imageBytes: number): ArrayBuffer {
  const image = 'x'.repeat(imageBytes);
  const files = zip({
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>',
    'word/media/p.png': image,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Hello text</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="P"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
  });
  return files.buffer.slice(files.byteOffset, files.byteOffset + files.byteLength) as ArrayBuffer;
}

describe('docxToHtml', () => {
  test('a document with a 1.6 MB picture still previews: its text, no picture, small markup', async () => {
    const bytes = docxWithPicture(1_600_000);
    const html = await docxToHtml(bytes, { buffer: Buffer.from(bytes) });
    expect(html).toContain('Hello text');
    expect(html).not.toMatch(/<img|base64/);
    expect(html.length).toBeLessThan(1000);
  });
});

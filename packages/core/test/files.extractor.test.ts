import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ExtractedDocumentSchema } from '@living-wiki/contracts';
import { FakeExtractor, HttpExtractor, UnavailableExtractor, createExtractor } from '../src/files/extractor.js';
import type { DetectedFile } from '../src/files/detect.js';

const enc = (s: string) => new TextEncoder().encode(s);
const pdf: DetectedFile = { type: 'pdf', mimeType: 'application/pdf', extension: 'pdf', handling: 'extractor' };
const fixture = JSON.parse(
  readFileSync(new URL('../../contracts/fixtures/extracted-sample.json', import.meta.url), 'utf8')
);

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  return 'resolved';
}

describe('FakeExtractor', () => {
  const fake = new FakeExtractor();
  const run = (text: string) => fake.extract({ bytes: enc(text), fileName: 'a.pdf', file: pdf });

  it('reads JSON after the marker as the extracted document', async () => {
    expect(await run(`FAKE-EXTRACT\n${JSON.stringify(fixture)}`)).toEqual(fixture);
  });

  it('reads plain text after the marker as one section per form-feed page', async () => {
    const doc = await run('FAKE-EXTRACT\nfirst page\fsecond page');
    expect(doc.pageCount).toBe(2);
    expect(doc.sections.map((s) => [s.pageFrom, s.pageTo, s.text])).toEqual([
      [1, 1, 'first page'],
      [2, 2, 'second page'],
    ]);
    ExtractedDocumentSchema.parse(doc);
  });

  it('yields no sections for FAKE-EXTRACT-EMPTY', async () => {
    expect((await run('FAKE-EXTRACT-EMPTY\n')).sections).toEqual([]);
  });

  it('is unavailable for FAKE-EXTRACT-DOWN', async () => {
    expect(await codeOf(run('FAKE-EXTRACT-DOWN\n'))).toBe('extractor_unavailable');
  });

  it('cannot read bytes without the marker, or JSON that breaks the contract', async () => {
    expect(await codeOf(run('just some bytes'))).toBe('file_unreadable');
    expect(await codeOf(run('FAKE-EXTRACT\n{"sections": 3}'))).toBe('file_unreadable');
  });
});

describe('HttpExtractor', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  async function serve(
    handler: (req: IncomingMessage, body: Buffer) => { status: number; body?: string } | 'hang'
  ): Promise<{ url: string; seen: Array<{ headers: IncomingMessage['headers']; body: Buffer; url?: string; method?: string }> }> {
    const seen: Array<{ headers: IncomingMessage['headers']; body: Buffer; url?: string; method?: string }> = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ headers: req.headers, body, url: req.url, method: req.method });
        const answer = handler(req, body);
        if (answer === 'hang') return;
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(answer.body ?? '');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen };
  }

  const extract = (url: string, timeoutMs = 2000) =>
    new HttpExtractor({ url, timeoutMs }).extract({ bytes: enc('%PDF-1.7 data'), fileName: 'Q3 report ü.pdf', file: pdf });

  it('posts the bytes with the name and type, and parses the answer', async () => {
    const { url, seen } = await serve(() => ({ status: 200, body: JSON.stringify(fixture) }));
    expect(await extract(url)).toEqual(fixture);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url).toBe('/extract');
    expect(seen[0]!.body.toString()).toBe('%PDF-1.7 data');
    expect(seen[0]!.headers['x-file-type']).toBe('pdf');
    expect(decodeURIComponent(String(seen[0]!.headers['x-file-name']))).toBe('Q3 report ü.pdf');
  });

  it('maps 422 to file_unreadable and 413 to file_text_too_large', async () => {
    const a = await serve(() => ({ status: 422, body: '{"error":"unreadable"}' }));
    expect(await codeOf(extract(a.url))).toBe('file_unreadable');
    await new Promise<void>((r) => server!.close(() => r()));
    const b = await serve(() => ({ status: 413, body: '{"error":"too_large"}' }));
    expect(await codeOf(extract(b.url))).toBe('file_text_too_large');
  });

  it('treats a 500, an answer that breaks the contract, and no listener as unavailable', async () => {
    const a = await serve(() => ({ status: 500, body: 'boom' }));
    expect(await codeOf(extract(a.url))).toBe('extractor_unavailable');
    await new Promise<void>((r) => server!.close(() => r()));
    const b = await serve(() => ({ status: 200, body: '{}' }));
    expect(await codeOf(extract(b.url))).toBe('extractor_unavailable');
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    expect(await codeOf(extract('http://127.0.0.1:9'))).toBe('extractor_unavailable');
  });

  it('gives up after the timeout and keeps the cause', async () => {
    const { url } = await serve(() => 'hang');
    try {
      await extract(url, 50);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).code).toBe('extractor_unavailable');
      expect((err as AppError).cause).toBeDefined();
    }
  });
});

describe('createExtractor', () => {
  const input = { bytes: enc('x'), fileName: 'a.pdf', file: pdf };

  it('is unavailable when off', async () => {
    const extractor = createExtractor({ EXTRACTOR_MODE: 'off', EXTRACTOR_TIMEOUT_MS: 1000 });
    expect(extractor).toBeInstanceOf(UnavailableExtractor);
    expect(await codeOf(extractor.extract(input))).toBe('extractor_unavailable');
  });

  it('builds the fake and the HTTP client', () => {
    expect(createExtractor({ EXTRACTOR_MODE: 'fake', EXTRACTOR_TIMEOUT_MS: 1000 })).toBeInstanceOf(FakeExtractor);
    expect(
      createExtractor({ EXTRACTOR_MODE: 'http', EXTRACTOR_URL: 'http://x:1', EXTRACTOR_TIMEOUT_MS: 1000 })
    ).toBeInstanceOf(HttpExtractor);
  });
});

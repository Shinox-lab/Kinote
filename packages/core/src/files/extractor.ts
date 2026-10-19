import { AppError, ExtractedDocumentSchema, type ExtractedDocument } from '@living-wiki/contracts';
import type { DetectedFile } from './detect.js';

export interface ExtractInput {
  bytes: Uint8Array;
  fileName: string;
  file: DetectedFile;
}

/** Turns a file's bytes into text with structure. Throws `AppError`s: `extractor_unavailable` (retry), `file_unreadable`, `file_text_too_large`. */
export interface Extractor {
  extract(input: ExtractInput): Promise<ExtractedDocument>;
}

function withCause(error: AppError, cause: unknown): AppError {
  error.cause = cause;
  return error;
}

/**
 * An `extractor_unavailable` whose cause is a fixed sentence. The cause ends up in
 * `versions.error`, which every viewer of the file can read, so it never carries a
 * network error, a response body or a validation dump; the real error goes to the
 * worker's log for operators.
 */
function unavailable(neutralCause: string, real?: unknown): AppError {
  if (real !== undefined) {
    console.warn(`[extractor] ${neutralCause}:`, real instanceof Error ? real.message : real);
  }
  return withCause(new AppError('extractor_unavailable'), new Error(neutralCause));
}

/** The extractor of a stack that has none: every call fails as unavailable, so files wait and can be retried. */
export class UnavailableExtractor implements Extractor {
  async extract(): Promise<ExtractedDocument> {
    throw new AppError('extractor_unavailable');
  }
}

const MARKER_LINE = /^FAKE-EXTRACT(?:-(DOWN|EMPTY))?[ \t]*$/m;

/**
 * A deterministic extractor for tests and local e2e: the file's bytes carry
 * their own text. A line `FAKE-EXTRACT` (after any real file signature such as
 * `%PDF-1.7`) is followed by either JSON in the `ExtractedDocument` shape or
 * plain text (one section per form-feed page); the line `FAKE-EXTRACT-EMPTY`
 * reads as no text, `FAKE-EXTRACT-DOWN` as an extractor that is down; bytes
 * without a marker line are an unreadable file.
 */
export class FakeExtractor implements Extractor {
  async extract({ bytes }: ExtractInput): Promise<ExtractedDocument> {
    const text = new TextDecoder('utf-8').decode(bytes);
    const marker = MARKER_LINE.exec(text);
    if (!marker) throw new AppError('file_unreadable');
    if (marker[1] === 'DOWN') throw new AppError('extractor_unavailable');
    if (marker[1] === 'EMPTY') return { pageCount: 0, sections: [], ocrUsed: false };
    const rest = text.slice(marker.index + marker[0].length).replace(/^\r?\n/, '');
    if (rest.trimStart().startsWith('{')) {
      try {
        return ExtractedDocumentSchema.parse(JSON.parse(rest));
      } catch (err) {
        throw withCause(new AppError('file_unreadable'), err);
      }
    }
    const pages = rest.split('\f');
    return {
      pageCount: pages.length,
      ocrUsed: false,
      sections: pages.map((page, i) => ({
        headingPath: [],
        pageFrom: i + 1,
        pageTo: i + 1,
        kind: 'text' as const,
        text: page,
      })),
    };
  }
}

/** The Docling service over HTTP: `POST {url}/extract` with the bytes, the name and the type. */
export class HttpExtractor implements Extractor {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { url: string; timeoutMs: number; fetchImpl?: typeof fetch }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async extract({ bytes, fileName, file }: ExtractInput): Promise<ExtractedDocument> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.url}/extract`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(fileName),
          'x-file-type': file.type,
        },
        body: Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw unavailable(timedOut ? 'the extractor did not answer in time' : 'the extractor could not be reached', err);
    }
    if (response.status === 422) throw new AppError('file_unreadable');
    if (response.status === 413) throw new AppError('file_text_too_large');
    if (!response.ok) {
      throw unavailable(`the extractor answered ${response.status}`);
    }
    try {
      return ExtractedDocumentSchema.parse(await response.json());
    } catch (err) {
      throw unavailable('the extractor returned an unexpected answer', err);
    }
  }
}

/** The extractor the settings ask for. */
export function createExtractor(config: {
  EXTRACTOR_MODE: 'off' | 'fake' | 'http';
  EXTRACTOR_URL?: string;
  EXTRACTOR_TIMEOUT_MS: number;
}): Extractor {
  if (config.EXTRACTOR_MODE === 'fake') return new FakeExtractor();
  if (config.EXTRACTOR_MODE === 'http' && config.EXTRACTOR_URL) {
    return new HttpExtractor({ url: config.EXTRACTOR_URL, timeoutMs: config.EXTRACTOR_TIMEOUT_MS });
  }
  return new UnavailableExtractor();
}

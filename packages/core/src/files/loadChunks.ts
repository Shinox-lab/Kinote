import { ExtractedDocumentSchema, type ExtractedDocument } from '@kinote/contracts';
import { NonRetryableError } from '@kinote/db';
import type { ObjectStorage } from '@kinote/shared';
import { chunkExtracted } from './chunkExtracted.js';
import type { RawChunk } from '../indexing/chunkPage.js';

/**
 * Reads a file version's `extracted.json` and cuts it into the chunks it would
 * be (or is) indexed as. The same function serves indexing and the chunk
 * inspector, so what a reviewer sees is what search will hold. A version with
 * no extracted text, or text that breaks the contract, can never be indexed:
 * `NonRetryableError`.
 */
export async function loadFileChunks(
  storage: ObjectStorage,
  tenantId: string,
  ver: { title: string; extractedKey: string | null }
): Promise<{ extracted: ExtractedDocument; chunks: RawChunk[] }> {
  if (!ver.extractedKey) throw new NonRetryableError('version has no extracted text');
  const { bytes } = await storage.get(tenantId, ver.extractedKey);
  const parsed = ExtractedDocumentSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!parsed.success) throw new NonRetryableError('extracted text does not match its contract');
  return { extracted: parsed.data, chunks: chunkExtracted(ver.title, parsed.data.sections) };
}

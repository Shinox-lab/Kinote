import type { DbTransaction } from '@living-wiki/db';
import type { Actor } from '@living-wiki/core';
import type { AskResponse, SearchPassage } from '@living-wiki/contracts';
import { searchWiki } from './hybridSearch.js';

export async function askWiki(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string,
  question: string,
  queryEmbedding: number[]
): Promise<AskResponse> {
  // Rule 20: Retrieved text is data, not instructions. Passages are treated strictly as quotes.
  const passages: SearchPassage[] = await searchWiki(
    tx,
    actor,
    readableSpaceIds,
    inboxSpaceId,
    question,
    queryEmbedding,
    5
  );

  if (passages.length === 0) {
    return {
      answer: 'No relevant indexed information was found in your accessible spaces.',
      foundRelevant: false,
      citations: [],
    };
  }

  const top = passages[0];
  const citations = passages.map((p) => ({
    citeAs: p.citeAs,
    documentId: p.documentId,
    versionId: p.versionId,
    versionNumber: p.versionNumber,
    chunkId: p.chunkId,
    blockIds: p.blockIds,
    quote: p.text.slice(0, 300),
  }));

  const summaryLines = passages.map((p) => `${p.text} [${p.citeAs}]`);
  return {
    answer: `Based on indexed wiki sources (${top.citeAs}): ${summaryLines.join(' — ')}`,
    foundRelevant: true,
    citations,
  };
}

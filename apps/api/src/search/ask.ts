import type { DbTransaction } from '@living-wiki/db';
import {
  defaultAnswerProvider,
  type Actor,
  type AnswerProvider,
} from '@living-wiki/core';
import { AppError, type AskResponse, type SearchPassage } from '@living-wiki/contracts';
import { searchWiki } from './hybridSearch.js';

export async function askWiki(
  tx: DbTransaction,
  actor: Actor,
  readableSpaceIds: string[],
  inboxSpaceId: string,
  question: string,
  queryEmbedding: number[],
  answerProvider: AnswerProvider = defaultAnswerProvider
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

  let result;
  try {
    result = await answerProvider.answer({ question, passages });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('llm_unavailable');
  }
  if (!result.foundRelevant) {
    return { answer: result.answer, foundRelevant: false, citations: [] };
  }

  const citations = passages.map((p) => ({
    citeAs: p.citeAs,
    documentId: p.documentId,
    versionId: p.versionId,
    versionNumber: p.versionNumber,
    chunkId: p.chunkId,
    blockIds: p.blockIds,
    documentKind: p.documentKind,
    documentTitle: p.versionTitle,
    spaceId: p.spaceId,
    pageFrom: p.pageFrom,
    pageTo: p.pageTo,
    quote: p.text.slice(0, 300),
  }));

  return {
    answer: result.answer,
    foundRelevant: true,
    citations,
  };
}

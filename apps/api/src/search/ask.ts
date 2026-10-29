import {
  defaultAnswerProvider,
  NO_RELEVANT_ANSWER,
  type AnswerProvider,
  type CollectionTable,
} from '@kinote/core';
import { AppError, type AskResponse, type SearchPassage } from '@kinote/contracts';

/**
 * Turns already-retrieved passages into an answer. It deliberately takes no
 * transaction: the model call may take a minute and must not pin a database
 * connection.
 */
export async function answerPassages(
  question: string,
  passages: SearchPassage[],
  answerProvider: AnswerProvider = defaultAnswerProvider,
  tables: CollectionTable[] = []
): Promise<AskResponse> {
  if (passages.length === 0) {
    return {
      answer: NO_RELEVANT_ANSWER,
      foundRelevant: false,
      citations: [],
    };
  }

  let result;
  try {
    result = await answerProvider.answer({ question, passages, ...(tables.length > 0 ? { tables } : {}) });
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

  // A table row is cited only when the answer used it.
  for (const t of tables) {
    for (const r of t.rows) {
      if (!result.answer.includes(`[${r.citeAs}]`) || citations.some((c) => c.versionId === r.versionId)) continue;
      citations.push({
        citeAs: r.citeAs,
        documentId: r.documentId,
        versionId: r.versionId,
        versionNumber: r.versionNumber,
        chunkId: r.chunkId,
        blockIds: [],
        documentKind: 'page',
        documentTitle: r.title,
        spaceId: r.spaceId,
        pageFrom: null,
        pageTo: null,
        quote: `${r.title} — ${Object.entries(r.values).map(([k, v]) => `${k}: ${v}`).join(', ')}`.slice(0, 300),
      });
    }
  }

  return {
    answer: result.answer,
    foundRelevant: true,
    citations,
  };
}

import {
  defaultAnswerProvider,
  NO_RELEVANT_ANSWER,
  type AnswerProvider,
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
  answerProvider: AnswerProvider = defaultAnswerProvider
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

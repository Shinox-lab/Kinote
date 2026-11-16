import { readAskModel, withTenantTx } from '@kinote/db';
import { AppError, type AskResponse } from '@kinote/contracts';
import {
  collectionTables,
  getReadableSpaceIds,
  searchWiki,
  type Actor,
  type AnswerProvider,
  type EmbeddingProvider,
  type ModelProviders,
} from '@kinote/core';
import { answerPassages } from './ask.js';

/** Passages an answer is written from. */
const ASK_PASSAGES = 5;

/**
 * Ask: embeds the question, takes the top passages from the actor's readable spaces (narrowed to `spaceIds`
 * when given), reads collection rows as tables when the passages come from a collection, and writes the answer
 * outside the transaction. Shared by POST /api/v1/ask and the MCP `kinote_ask` tool; the caller charges the
 * AI action first. `search_unavailable` when the question cannot be embedded.
 */
export async function askWiki(
  actor: Actor,
  input: { question: string; spaceIds?: string[] },
  deps: { embeddingProvider: EmbeddingProvider; answerProvider: AnswerProvider; models?: ModelProviders }
): Promise<AskResponse> {
  let queryEmbedding: number[];
  try {
    [queryEmbedding] = (await deps.embeddingProvider.embed([input.question], 'query')) as [number[]];
  } catch {
    throw new AppError('search_unavailable');
  }

  const { passages, tables, askModel } = await withTenantTx(actor.tenantId, async (tx) => {
    const { readableSpaceIds, inboxSpaceId } = await getReadableSpaceIds(tx, actor);
    const effectiveSpaces = input.spaceIds ? readableSpaceIds.filter((id) => input.spaceIds!.includes(id)) : readableSpaceIds;
    const passages = await searchWiki(
      tx,
      actor,
      effectiveSpaces,
      inboxSpaceId,
      input.question,
      queryEmbedding,
      ASK_PASSAGES,
      deps.embeddingProvider.model
    );
    // Questions across a collection ("which clients launch in December?") read its rows as a table.
    const tables = passages.length > 0 ? await collectionTables(tx, actor, effectiveSpaces, passages) : [];
    return { passages, tables, askModel: deps.models ? await readAskModel(tx, actor.tenantId) : null };
  });
  return answerPassages(input.question, passages, deps.models ? deps.models.answerFor(askModel) : deps.answerProvider, tables);
}

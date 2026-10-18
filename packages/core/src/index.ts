export {
  requireSpaceRole,
  getReadableSpaceIds,
  assertValidUuid,
  type Actor,
  type SpaceRole,
} from './permissions.js';
export { takePageSnapshot, type TakePageSnapshotHooks } from './snapshot.js';
export { indexVersion, type IndexVersionResult } from './indexing/indexVersion.js';
export { principalKey, chunkInboxOwner } from './indexing/inboxOwner.js';
export {
  chunkPageBlocks,
  DEFAULT_CHUNK_OPTIONS,
  type ChunkOptions,
  type RawChunk,
} from './indexing/chunkPage.js';
export {
  DeterministicEmbeddingProvider,
  defaultEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding.js';

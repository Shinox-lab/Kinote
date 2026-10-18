export {
  requireSpaceRole,
  getReadableSpaceIds,
  assertValidUuid,
  type Actor,
  type SpaceRole,
} from './permissions.js';
export { takePageSnapshot } from './snapshot.js';
export { indexVersion, chunkPageBlocks } from './indexing/indexVersion.js';
export {
  DeterministicEmbeddingProvider,
  defaultEmbeddingProvider,
  type EmbeddingProvider,
} from './embedding.js';

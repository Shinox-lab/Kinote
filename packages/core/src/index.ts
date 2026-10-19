export {
  requireSpaceRole,
  requireDocumentRole,
  getReadableSpaceIds,
  assertValidUuid,
  isTenantAdmin,
  type Actor,
  type SpaceRole,
  type SpaceAccess,
  type SpaceRoleOptions,
  type DocumentRoleOptions,
} from './permissions.js';
export { takePageSnapshot, type TakePageSnapshotHooks } from './snapshot.js';
export { indexVersion, type IndexVersionResult } from './indexing/indexVersion.js';
export { principalKey, chunkInboxOwner, pageSlugScope } from './indexing/inboxOwner.js';
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
export {
  detectFileType,
  listZipEntries,
  cleanFileName,
  type DetectedFile,
  type DetectResult,
  type FileHandling,
} from './files/detect.js';

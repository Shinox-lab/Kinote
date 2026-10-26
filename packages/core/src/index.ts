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
export { indexVersion, type IndexVersionResult, type IndexDeps } from './indexing/indexVersion.js';
export { loadFileChunks } from './files/loadChunks.js';
export { principalKey, chunkInboxOwner, pageSlugScope } from './indexing/inboxOwner.js';
export {
  chunkPageBlocks,
  DEFAULT_CHUNK_OPTIONS,
  type ChunkOptions,
  type RawChunk,
} from './indexing/chunkPage.js';
export {
  EMBEDDING_DIMENSIONS,
  DeterministicEmbeddingProvider,
  OpenAIEmbeddingProvider,
  createEmbeddingProvider,
  defaultEmbeddingProvider,
  type EmbeddingKind,
  type EmbeddingProvider,
} from './embedding.js';
export {
  DeterministicAnswerProvider,
  NO_RELEVANT_ANSWER,
  OpenAIAnswerProvider,
  createAnswerProvider,
  defaultAnswerProvider,
  type AnswerProvider,
} from './answer.js';
export {
  detectFileType,
  listZipEntries,
  cleanFileName,
  type DetectedFile,
  type DetectResult,
  type FileHandling,
} from './files/detect.js';
export { readTextNative, parseCsv } from './files/textNative.js';
export { chunkExtracted } from './files/chunkExtracted.js';
export {
  FakeExtractor,
  HttpExtractor,
  UnavailableExtractor,
  createExtractor,
  type Extractor,
  type ExtractInput,
} from './files/extractor.js';
export {
  fileObjectPath,
  insertFileVersion,
  type InsertFileVersionParams,
  type VersionRow,
} from './files/versions.js';
export {
  extractVersion,
  type ExtractDeps,
  type ExtractVersionResult,
} from './files/extractVersion.js';
export { chatJson, type ChatJsonOptions } from './llm/chatJson.js';
export {
  DeterministicPlacementModel,
  OpenAIPlacementModel,
  createPlacementModel,
  defaultPlacementModel,
  type PlacementModel,
  type EntityKind,
  type EdgeType,
  type ExtractedEntity,
  type ExtractedEdge,
} from './placement/model.js';
export { buildPageCard, pageOutline, type BuildPageCardResult } from './placement/pageCard.js';
export {
  extractVersionEntities,
  previousEntityIds,
  deleteOrphanEntities,
  ENTITY_MATCH,
  type ExtractEntitiesResult,
} from './placement/entities.js';

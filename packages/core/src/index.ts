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
  type RoutingModel,
  type CaptureFact,
  type PlanCandidate,
  type PlannedOp,
  type PlannedEdit,
  type PlanEditsInput,
  type CaptureShape,
  type DocumentPlacement,
  type PlaceDocumentInput,
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
export { deletePlacementIndex, movePlacementIndex, enqueuePlacementJobs } from './placement/derived.js';
export {
  searchPageCards,
  findEntities,
  pagesForEntities,
  type PlacementFilter,
  type CardHit,
  type EntityHit,
  type GraphPageHit,
} from './placement/queries.js';
export {
  BRANCH_LIMIT,
  chunkFilterFor,
  vectorBranchSql,
  ftsBranchSql,
  searchSql,
  searchWiki,
  type ChunkFilter,
} from './search/hybridSearch.js';
export { senderActor, senderAccess, type SenderAccess } from './routing/access.js';
export { readLiveBlocks, blockText, blockMarkdown, markdownBlocks, encodeBlocksYDoc } from './routing/liveBlocks.js';
export {
  planCapture,
  splitCaptureText,
  decideShape,
  pageTree,
  ROUTING,
  type CheckedEdit,
  type FactPlan,
  type Gate,
  type PlanDeps,
  type PlanFactInput,
  type PlannedFact,
} from './routing/plan.js';
export { ensureRouterAgent } from './routing/routerAgent.js';
export {
  routeCapture,
  finishCapture,
  applyPlannedFacts,
  failCapture,
  ROUTING_LEASE_SECONDS,
  QUESTION_TTL_DAYS,
  type RouteDeps,
} from './routing/apply.js';
export { placeFact, recordRoutingExample } from './routing/place.js';
export { planDocument, uniqueChildTitle, similarDocumentExamples, type DocumentPlan } from './routing/document.js';
export {
  notify,
  excerptOf,
  memberActors,
  memberNames,
  canOpen,
  usersWithSpaceRole,
  recordPageMentions,
  textMentions,
  hasUnreadAbout,
  type NotificationInput,
  type NotificationKind,
} from './talk/notify.js';
export { relocateFile, returnToReview, type RelocateTarget } from './files/relocate.js';
export {
  prepareCaptureFile,
  routedText,
  attachCaptureFile,
  returnCaptureFile,
  CAPTURE_FILE_MAX_CHARS,
  CAPTURE_FILE_MESSAGES,
  type CaptureFileState,
} from './routing/captureFile.js';

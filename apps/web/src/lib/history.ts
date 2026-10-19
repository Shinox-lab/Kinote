import type { VersionReason, VersionStatus, VersionSummary } from '@living-wiki/contracts';
import { authorLabel, type AuthorLabel } from './wiki.js';

// Pure helpers behind the history drawer: labels for the contract's version
// enums, who made a version, and which two versions to compare first.

const STATUS: Record<VersionStatus, string> = {
  extracting: 'Extracting',
  pending_review: 'Awaiting review',
  indexing: 'Indexing',
  indexed: 'Indexed',
  superseded: 'Superseded',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  failed: 'Failed',
  stored: 'Stored',
};

const REASON: Record<VersionReason, string> = {
  quiet: 'Autosaved',
  submit: 'Submitted',
  agent: 'Agent change',
  restore: 'Restored',
  upload: 'Uploaded',
  source: 'Synced from a source',
  transcript: 'Transcript',
};

export function versionStatusLabel(status: VersionStatus): string {
  return STATUS[status];
}

export function versionReasonLabel(reason: VersionReason): string {
  return REASON[reason];
}

/** Who made a version: "You", a known name, or a neutral name with a short id (the API only publishes names to admins). */
export function versionWho(
  version: Pick<VersionSummary, 'createdByType' | 'createdBy'>,
  names: ReadonlyMap<string, string>,
  selfId: string | null
): AuthorLabel {
  if (version.createdByType === 'connector') return { name: 'Connector', isAgent: false };
  return authorLabel({ type: version.createdByType, id: version.createdBy }, names, selfId);
}

/** A timestamp for the reader's locale; text that is not a date is shown as it came. */
export function whenLabel(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/** The first comparison to offer: the second newest version against the newest (the list is newest first). */
export function defaultComparison(versions: readonly Pick<VersionSummary, 'number'>[]): { from: number; to: number } | null {
  return versions.length >= 2 ? { from: versions[1].number, to: versions[0].number } : null;
}

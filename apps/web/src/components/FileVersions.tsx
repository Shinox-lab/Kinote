import type { SpaceRole } from '@living-wiki/contracts';
import { useFileVersions, useWorkspace } from '../lib/queries.js';
import { formatBytes } from '../lib/fileUi.js';
import { versionReasonLabel, versionStatusLabel, versionWho, whenLabel } from '../lib/history.js';
import { loadSession } from '../lib/session.js';
import { DocumentLink } from './DocumentLink.js';
import { ErrorNote, Loading } from './ui.js';

/**
 * A file's versions, newest first. Editors open any of them; everyone else sees the
 * list but only the published (indexed) version has a link, since the server shows
 * no other version's bytes to them.
 */
export function FileVersions({
  fileId,
  role,
  shownId,
}: {
  fileId: string;
  role: SpaceRole | null;
  /** The version the screen is showing now. */
  shownId: string | null;
}) {
  const { tenant } = useWorkspace();
  const { data: versions, error, isPending } = useFileVersions(fileId);
  const selfId = loadSession()?.user.id ?? null;
  const editor = role === 'editor' || role === 'reviewer' || role === 'admin';

  if (isPending) return <Loading what="versions" />;
  if (error) return <ErrorNote error={error} />;
  return (
    <ol aria-label="Versions" className="flex flex-col divide-y divide-line">
      {versions.map((v) => {
        const who = versionWho(v, selfId);
        const openable = editor || v.status === 'indexed';
        const current = v.id === shownId;
        return (
          <li key={v.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
            {openable ? (
              <DocumentLink
                tenantSlug={tenant.slug}
                kind="file"
                id={fileId}
                version={v.id}
                className="font-medium text-accent-text hover:underline"
              >
                {`Version ${v.number}`}
              </DocumentLink>
            ) : (
              <span className="font-medium">{`Version ${v.number}`}</span>
            )}
            {current && <span className="rounded border border-line px-1.5 text-[10px] uppercase tracking-wide text-muted">Showing</span>}
            <span className="text-muted">
              {versionStatusLabel(v.status)} · {versionReasonLabel(v.reason)} · {who.name} · {formatBytes(v.sizeBytes)} ·{' '}
              <time dateTime={v.createdAt}>{whenLabel(v.createdAt)}</time>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

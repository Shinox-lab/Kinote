import { useRef } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { FileDetails, FileVersion } from '@living-wiki/contracts';
import { ApiError, api } from '../lib/api.js';
import { saveVersion } from '../lib/download.js';
import { fileBanner, fileControls, formatBytes, publishedVersionId } from '../lib/fileUi.js';
import { useFile, useFileVersions, useRefresh, useSpaces, useSpaceTree, useWorkspace } from '../lib/queries.js';
import { ancestorIds, type BadgeTone } from '../lib/wiki.js';
import { ChunkInspector } from '../components/ChunkInspector.js';
import { FileViewer } from '../viewers/FileViewer.js';
import { Badge } from '../components/Badge.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { FileMenu } from '../components/FileMenu.js';
import { FileVersions } from '../components/FileVersions.js';
import { Button, Card, ErrorNote, Loading } from '../components/ui.js';

const CRUMB = 'max-w-[12rem] truncate rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg';

const BANNER_TONE: Record<BadgeTone, string> = {
  ok: 'border-line bg-success-bg text-success',
  danger: 'border-danger bg-danger-bg text-danger',
  muted: 'border-line bg-hover text-fg',
  pending: 'border-line bg-hover text-fg',
};

/** The file's place in the workspace: its space, then each parent page, as links. */
function Breadcrumb({ file, tenantSlug }: { file: FileDetails; tenantSlug: string }) {
  const { data: spaces = [] } = useSpaces();
  const { data: tree } = useSpaceTree(file.spaceId);
  const space = spaces.find((s) => s.id === file.spaceId);
  const nodes = tree?.nodes ?? [];
  const parents = ancestorIds(nodes, file.id)
    .map((id) => nodes.find((n) => n.id === id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 text-sm">
      <ol className="flex flex-wrap items-center gap-0.5">
        {space && (
          <li className="flex items-center gap-0.5">
            <Link to="/w/$tenantSlug/s/$spaceSlug" params={{ tenantSlug, spaceSlug: space.slug }} className={CRUMB}>
              {space.name}
            </Link>
          </li>
        )}
        {parents.map((p) => (
          <li key={p.id} className="flex items-center gap-0.5">
            <span aria-hidden="true" className="text-muted">
              /
            </span>
            <DocumentLink tenantSlug={tenantSlug} kind={p.kind} id={p.id} className={CRUMB}>
              {p.title}
            </DocumentLink>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The version on screen: the one asked for (editors only, and only if it exists), else the published one. */
function useShownVersion(file: FileDetails | undefined, wanted: string | undefined) {
  const { data: spaces = [] } = useSpaces();
  const role = file ? (spaces.find((s) => s.id === file.spaceId)?.myRole ?? null) : null;
  const editor = role === 'editor' || role === 'reviewer' || role === 'admin';
  const { data: versions } = useFileVersions(file?.id ?? '', file !== undefined && editor && wanted !== undefined);
  if (!file) return { role, shown: null as FileVersion | null };
  const asked = editor && wanted !== undefined ? versions?.find((v) => v.id === wanted) : undefined;
  const id = asked?.id ?? publishedVersionId(file, role);
  const shown = [asked, file.latestVersion, file.indexedVersion].find((v) => v && v.id === id) ?? null;
  return { role, shown };
}

/** `/w/$tenantSlug/f/$fileId`: an uploaded file, its status, its versions and what can be done with it. */
export function FilePage() {
  const { tenant } = useWorkspace();
  const { fileId } = useParams({ from: '/w/$tenantSlug/f/$fileId' });
  const search = useSearch({ from: '/w/$tenantSlug/f/$fileId' });
  const refresh = useRefresh();
  const { data: spaces = [] } = useSpaces();
  const { data: file, error, isPending } = useFile(fileId);
  const { role, shown } = useShownVersion(file, search.v);
  const picker = useRef<HTMLInputElement>(null);

  const changed = () => {
    void refresh('file');
    void refresh('tree');
    void refresh('archived');
    void refresh('updates');
    void refresh('reviews');
  };
  const replace = useMutation({
    mutationFn: (form: FormData) => api.replaceFile(fileId, form),
    onSettled: changed,
  });
  const retry = useMutation({ mutationFn: (versionId: string) => api.retryVersion(versionId), onSettled: changed });
  const save = useMutation({ mutationFn: () => saveVersion(shown!.id, shown!.fileName) });

  if (isPending) return <Loading what="file" />;
  if (error || !file) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      return (
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold">File not found</h1>
          <p className="text-sm text-muted">This file does not exist, or you cannot open it.</p>
          <Link to="/w/$tenantSlug" params={{ tenantSlug: tenant.slug }} className="text-sm font-medium text-accent-text underline">
            Back to the workspace
          </Link>
        </div>
      );
    }
    return <ErrorNote error={error} />;
  }

  const space = spaces.find((s) => s.id === file.spaceId);
  const archived = file.archivedAt !== null;
  const controls = fileControls({
    role,
    spaceArchived: (space?.archivedAt ?? null) !== null,
    archived,
    placement: file.placement,
    sourceDeleted: file.sourceDeletedAt !== null,
    badge: file.badge,
  });
  const banner = fileBanner({
    badge: file.badge,
    sourceDeleted: file.sourceDeletedAt !== null,
    placement: file.placement,
    hasPublished: file.indexedVersion !== null,
    role,
  });
  const failedId = file.latestVersion?.id;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3">
        <Breadcrumb file={file} tenantSlug={tenant.slug} />
        {role && space && <FileMenu file={file} spaces={spaces} controls={controls} onChanged={changed} />}
      </div>

      {/* The name and the state of the file, at the top. */}
      <header className="flex flex-col gap-2">
        <h1 className="min-w-0 break-words text-3xl font-semibold tracking-tight">{file.title}</h1>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          <Badge badge={file.badge} label="File status" />
          {archived && <span className="rounded bg-dot-review/15 px-1.5 text-xs text-fg">Archived</span>}
          {shown && (
            <span>
              {shown.fileName} · {formatBytes(shown.sizeBytes)} · version {shown.number}
            </span>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {shown && controls.download && (
          <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
            Download
          </Button>
        )}
        {controls.replace && (
          <>
            <Button variant="secondary" onClick={() => picker.current?.click()} disabled={replace.isPending}>
              Replace file
            </Button>
            <input
              ref={picker}
              type="file"
              hidden
              aria-label="Choose the replacement file"
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                e.target.value = '';
                if (!chosen) return;
                const form = new FormData();
                form.set('file', chosen, chosen.name);
                replace.mutate(form);
              }}
            />
          </>
        )}
        {controls.retry && failedId && (
          <Button variant="secondary" onClick={() => retry.mutate(failedId)} disabled={retry.isPending}>
            Retry
          </Button>
        )}
        {controls.managedBy && <span className="text-sm text-muted">Kept in sync by a source: replace it there.</span>}
      </div>
      {banner && (
        <p role="note" className={`rounded-md border px-3 py-2 text-sm ${BANNER_TONE[banner.tone]}`}>
          {banner.text}
        </p>
      )}
      <ErrorNote error={save.error ?? replace.error ?? retry.error} />
      {replace.data?.unchanged && <p role="status" className="text-sm text-muted">That is the same file that is already here.</p>}

      {/* The file itself is the screen: the preview fills it. */}
      {shown && (
        <section aria-label="Preview" className="rounded-lg border border-line bg-surface p-4">
          <FileViewer version={shown} page={search.page} />
        </section>
      )}

      {/* How it is cut for search and what it looked like before: the rest. */}
      <div className={`grid gap-4 ${controls.chunks && shown ? 'lg:grid-cols-2' : ''}`}>
        {controls.chunks && shown && (
          <Card title="Search chunks">
            <ChunkInspector key={shown.id} versionId={shown.id} />
          </Card>
        )}
        <Card title="Versions">
          <FileVersions fileId={file.id} role={role} shownId={shown?.id ?? null} />
        </Card>
      </div>
    </div>
  );
}

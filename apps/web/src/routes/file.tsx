import { useEffect, useRef, useState } from 'react';
import { Link, useBlocker, useParams, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import type { FileDetails, FileVersion } from '@living-wiki/contracts';
import { ApiError, api } from '../lib/api.js';
import { saveVersion } from '../lib/download.js';
import { fileBanner, fileControls, formatBytes, publishedVersionId } from '../lib/fileUi.js';
import { fileType } from '../lib/fileType.js';
import { MIME } from '../lib/mime.js';
import { relativeTime } from '../lib/pageStatus.js';
import {
  useFile,
  useFileVersions,
  useRefresh,
  useSpaces,
  useSpaceTree,
  useVersionChunks,
  useWorkspace,
} from '../lib/queries.js';
import { useFocusTrap } from '../lib/useFocusTrap.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { ancestorIds, type BadgeTone } from '../lib/wiki.js';
import { AppTopBar } from '../components/AppTopBar.js';
import { Badge } from '../components/Badge.js';
import { DocumentLink } from '../components/DocumentLink.js';
import { FileMenu } from '../components/FileMenu.js';
import { FileRail } from '../components/FileRail.js';
import { FileTypeTile } from '../components/FileTypeTile.js';
import { FileViewer } from '../viewers/FileViewer.js';
import { TitleInput } from '../components/sidebar/TitleInput.js';
import { Button, ErrorNote, Loading } from '../components/ui.js';

const CRUMB = 'min-w-0 max-w-[12rem] truncate rounded px-1 py-0.5 text-muted hover:bg-hover hover:text-fg';

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
      <ol className="flex min-w-0 items-center gap-0.5">
        {space && (
          <li className="flex min-w-0 items-center gap-0.5">
            <Link to="/w/$tenantSlug/s/$spaceSlug" params={{ tenantSlug, spaceSlug: space.slug }} className={CRUMB}>
              {space.name}
            </Link>
          </li>
        )}
        {parents.map((p) => (
          <li key={p.id} className="flex items-center gap-0.5">
            <span aria-hidden="true" className="shrink-0 text-muted">
              /
            </span>
            <DocumentLink tenantSlug={tenantSlug} kind={p.kind} id={p.id} className={CRUMB}>
              {p.title}
            </DocumentLink>
          </li>
        ))}
        <li className="flex min-w-0 items-center gap-0.5">
          {(space || parents.length > 0) && (
            <span aria-hidden="true" className="shrink-0 text-muted">
              /
            </span>
          )}
          <span aria-current="page" className="min-w-0 max-w-[18rem] truncate px-1 py-0.5 font-medium text-fg">
            {file.title}
          </span>
        </li>
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

/** `/w/$tenantSlug/f/$fileId`: a file as identity, preview, and a rail of what it is and was. */
export function FilePage() {
  const { tenant } = useWorkspace();
  const { fileId } = useParams({ from: '/w/$tenantSlug/f/$fileId' });
  const search = useSearch({ from: '/w/$tenantSlug/f/$fileId' });
  const refresh = useRefresh();
  const wide = useMediaQuery('(min-width: 1200px)');
  const [railOpen, setRailOpen] = useState(wide);
  const [renaming, setRenaming] = useState(false);
  const [editorDirty, setEditorDirty] = useState(false);
  const { data: spaces = [] } = useSpaces();
  const { data: file, error, isPending } = useFile(fileId);
  const { role, shown } = useShownVersion(file, search.v);
  const picker = useRef<HTMLInputElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const leavePrompted = useRef(false);

  const space = file ? spaces.find((s) => s.id === file.spaceId) : undefined;
  const archived = file ? file.archivedAt !== null : false;
  const spaceArchived = (space?.archivedAt ?? null) !== null;
  const canChunks =
    file !== undefined && !archived && !spaceArchived && (role === 'editor' || role === 'reviewer' || role === 'admin');
  const { data: versions } = useFileVersions(file?.id ?? '', file !== undefined);
  // Chunks are heavy: only read them once the rail's Chunks tab asks for them.
  const [chunksFor, setChunksFor] = useState<string | null>(null);
  useEffect(() => setChunksFor(null), [shown?.id]);
  const chunks = useVersionChunks(chunksFor ?? '', canChunks && chunksFor !== null);
  const latest = versions?.[0];
  const pages = chunks.data?.pageCount ?? null;

  useEffect(() => {
    setRailOpen(wide);
  }, [wide]);

  // Below 1200 the rail is a sheet: the focus stays inside, Escape closes it, the page behind does not scroll.
  useFocusTrap(sheet, !wide && railOpen, () => setRailOpen(false));
  useEffect(() => {
    if (wide || !railOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [wide, railOpen]);

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
  const saveEditedFile = async (file: File) => {
    const form = new FormData();
    form.set('file', file, file.name);
    return replace.mutateAsync(form);
  };
  const retry = useMutation({
    mutationFn: (versionId: string) => api.retryVersion(versionId),
    onSettled: changed,
  });
  const save = useMutation({ mutationFn: () => saveVersion(shown!.id, shown!.fileName) });
  const rename = useMutation({
    mutationFn: (title: string) => api.renameFile(fileId, title),
    onSuccess: () => {
      setRenaming(false);
      changed();
    },
    // Keep the old title and let the page's error note say why; click again to retry.
    onError: () => setRenaming(false),
  });
  useEffect(() => {
    setRenaming(false);
    rename.reset();
    // A different file starts with its own title, not the one being edited.
  }, [fileId]);

  const { status, proceed, reset } = useBlocker({ shouldBlockFn: () => editorDirty, withResolver: true });
  useEffect(() => {
    if (status !== 'blocked') {
      leavePrompted.current = false;
      return;
    }
    if (leavePrompted.current) return;
    leavePrompted.current = true;
    if (window.confirm('Discard unsaved spreadsheet changes?')) proceed();
    else reset();
  }, [status, proceed, reset]);

  useEffect(() => {
    setEditorDirty(false);
  }, [fileId, shown?.id]);

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

  const controls = fileControls({
    role,
    spaceArchived,
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
  const canEditSpreadsheet =
    controls.replace && shown !== null && shown.id === file.latestVersion?.id && shown.mimeType === MIME.xlsx;
  const olderSpreadsheet =
    controls.replace &&
    shown !== null &&
    shown.mimeType === MIME.xlsx &&
    file.latestVersion !== null &&
    file.latestVersion.mimeType === MIME.xlsx &&
    shown.id !== file.latestVersion.id;
  const failedId = file.latestVersion?.id;
  const type = fileType(file.title, shown?.mimeType ?? latest?.mimeType);
  const info = (
    <FileRail
      file={file}
      shownId={shown?.id ?? null}
      role={role}
      space={space}
      controls={controls}
      chunks={chunks.data}
      chunksError={chunks.error}
      chunksPending={chunks.isPending}
      onLoadChunks={() => {
        if (shown && canChunks) setChunksFor(shown.id);
      }}
      onClose={() => setRailOpen(false)}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <AppTopBar
        crumbs={<Breadcrumb file={file} tenantSlug={tenant.slug} />}
        right={
          <>
            {shown && controls.download && (
              <Button
                variant="secondary"
                className="h-8 px-2.5 py-1 text-xs max-md:hidden"
                onClick={() => save.mutate()}
                disabled={save.isPending}
              >
                Download
              </Button>
            )}
            {role && space && (
              <FileMenu
                file={file}
                spaces={spaces}
                controls={controls}
                onReplace={() => picker.current?.click()}
                onDownload={() => save.mutate()}
                onChanged={changed}
              />
            )}
            {!railOpen && (
              <Button
                variant="secondary"
                className="h-8 px-2.5 py-1 text-xs"
                aria-controls="file-information"
                aria-expanded={railOpen}
                onClick={() => setRailOpen(true)}
              >
                Info
              </Button>
            )}
          </>
        }
      />

      <header className="flex flex-col gap-2">
        <FileTypeTile name={file.title} mimeType={shown?.mimeType ?? latest?.mimeType} />
        {renaming ? (
          <TitleInput
            title={file.title}
            onCancel={() => setRenaming(false)}
            onSave={(title) => rename.mutate(title)}
            className="text-[24px] font-semibold leading-tight tracking-[-0.02em] md:text-[1.875rem]"
          />
        ) : (
          <h1 className="min-w-0 break-words text-[24px] font-semibold leading-tight tracking-[-0.02em] text-fg md:text-[1.875rem]">
            {controls.replace ? (
              <button
                type="button"
                title="Rename file"
                onClick={() => {
                  rename.reset();
                  setRenaming(true);
                }}
                className="block w-full max-w-full rounded px-1 text-left hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {file.title}
              </button>
            ) : (
              file.title
            )}
          </h1>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Badge badge={file.badge} label="File status" />
          {archived && <span className="rounded-full bg-hover px-2 py-0.5 text-fg">Archived</span>}
          {shown && (
            <span>
              {type.label} · {formatBytes(shown.sizeBytes)}
              {pages !== null && ` · ${pages} ${pages === 1 ? 'page' : 'pages'}`}
              {latest && ` · uploaded ${relativeTime(latest.createdAt)}`}
            </span>
          )}
        </div>
      </header>

      {controls.managedBy && <p className="text-sm text-muted">Kept in sync by a source: replace it there.</p>}
      {banner && (
        <div className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-3 py-2 ${BANNER_TONE[banner.tone]}`}>
          <p role="note" className="text-sm">
            {banner.text}
          </p>
          {controls.retry && failedId && (
            <Button variant="secondary" onClick={() => retry.mutate(failedId)} disabled={retry.isPending}>
              {retry.isPending ? 'Retrying…' : 'Retry'}
            </Button>
          )}
        </div>
      )}
      <ErrorNote error={save.error ?? replace.error ?? retry.error ?? rename.error} />
      {replace.data?.unchanged && (
        <p role="status" className="text-sm text-muted">
          That is the same file that is already here.
        </p>
      )}
      {replace.data && !replace.data.unchanged && (
        <p role="status" className="text-sm text-muted">
          Saved as version {replace.data.version.number}. The new version is being read.
        </p>
      )}
      {controls.replace && (
        <input
          ref={picker}
          type="file"
          hidden
          aria-label="Choose the replacement file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            event.target.value = '';
            if (!chosen) return;
            const form = new FormData();
            form.set('file', chosen, chosen.name);
            replace.mutate(form);
          }}
        />
      )}

      <div className={wide && railOpen ? 'grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4' : ''}>
        <div className="min-w-0">
          {olderSpreadsheet && (
            <p className="mb-2 text-sm text-muted">Viewing an older version. Open the latest version to edit it.</p>
          )}
          {shown ? (
            <section aria-label="Preview" className="rounded-lg bg-file-mat p-3 md:p-4">
              <FileViewer
                version={shown}
                page={search.page}
                onSave={canEditSpreadsheet ? saveEditedFile : undefined}
                onDirtyChange={canEditSpreadsheet ? setEditorDirty : undefined}
              />
            </section>
          ) : (
            <p className="rounded-lg bg-hover px-4 py-8 text-center text-sm text-muted">Nothing has been published yet.</p>
          )}
        </div>
        {wide && railOpen && (
          <div id="file-information" className="min-w-0">
            {info}
          </div>
        )}
      </div>

      {!wide && railOpen && (
        <div className="fixed inset-0 z-30">
          <div aria-hidden="true" className="absolute inset-0 bg-overlay" onClick={() => setRailOpen(false)} />
          <div
            ref={sheet}
            id="file-information"
            role="dialog"
            aria-modal="true"
            aria-label="File information"
            tabIndex={-1}
            className="absolute inset-y-0 right-0 w-full overflow-y-auto border-l border-line bg-surface p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-pop outline-none md:w-[330px] md:max-w-[90vw]"
          >
            {info}
          </div>
        </div>
      )}
    </div>
  );
}

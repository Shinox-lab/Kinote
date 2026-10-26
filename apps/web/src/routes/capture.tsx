import { useSearch } from '@tanstack/react-router';
import { AppTopBar } from '../components/AppTopBar.js';
import { CaptureBox } from '../components/capture/CaptureBox.js';
import { CaptureCard } from '../components/capture/CaptureCard.js';
import { NeedsHome } from '../components/capture/NeedsHome.js';
import { ErrorNote, Loading } from '../components/ui.js';
import { useCaptures } from '../lib/queries.js';

/** `/w/$tenantSlug/capture`: drop anything in; the routing engine files it, and this page shows how. */
export function CapturePage() {
  const preset = useSearch({ from: '/w/$tenantSlug/capture' });
  const { data: captures, error, isPending } = useCaptures();
  return (
    <>
      <AppTopBar crumbs={<span className="text-sm font-medium text-fg">Capture</span>} />
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-fg">Capture</h1>
          <p className="text-sm text-muted">Anything you send is split into facts and filed on the right pages, with a receipt you can undo.</p>
        </header>
        <CaptureBox key={`${preset.space ?? ''}:${preset.page ?? ''}`} preset={preset} />
        <NeedsHome />
        <ErrorNote error={error} />
        {isPending ? (
          <Loading what="captures" />
        ) : captures && captures.length === 0 ? (
          <p className="text-sm text-muted">Nothing captured yet.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {(captures ?? []).map((c, index) => (
              <CaptureCard key={c.id} capture={c} defaultOpen={index === 0} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

import { useEffect } from 'react';
import { useVersionText } from '../lib/queries.js';
import { ErrorNote, Loading } from '../components/ui.js';

/**
 * A presentation as its text, slide by slide (the server read it; the browser does not open
 * PowerPoint files). The slide a search result points at is scrolled into view.
 */
export default function PptxViewer({ versionId, page }: { versionId: string; page?: number }) {
  const { data, error, isPending } = useVersionText(versionId);
  useEffect(() => {
    if (!data || page === undefined) return;
    document.getElementById(`slide-${page}`)?.scrollIntoView({ block: 'start' });
  }, [data, page]);

  if (error) return <ErrorNote error={error} />;
  if (isPending) return <Loading what="slides" />;
  if (data.pageCount === null) return <p className="text-sm text-muted">The text is still being read.</p>;
  if (data.sections.length === 0) return <p className="text-sm text-muted">No text was found in this presentation.</p>;
  return (
    <ol aria-label="Slides" className="flex flex-col gap-3">
      {data.sections.map((s, i) => {
        const slide = s.pageFrom ?? i + 1;
        return (
          <li key={i} id={`slide-${slide}`} className="rounded-md border border-line bg-surface p-3">
            <h3 className="mb-1 text-xs font-medium text-muted">Slide {slide}</h3>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm">{s.text}</pre>
          </li>
        );
      })}
    </ol>
  );
}

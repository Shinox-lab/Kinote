import { useParams } from '@tanstack/react-router';
import { useFile } from '../lib/queries.js';
import { Badge } from '../components/Badge.js';
import { ErrorNote, Loading } from '../components/ui.js';

/** `/w/$tenantSlug/f/$fileId`: an uploaded file, its status and (as it is built up) its preview and actions. */
export function FilePage() {
  const { fileId } = useParams({ from: '/w/$tenantSlug/f/$fileId' });
  const { data: file, error, isPending } = useFile(fileId);
  if (isPending) return <Loading what="file" />;
  if (error || !file) return <ErrorNote error={error} />;
  return (
    <div className="flex flex-col gap-4">
      <h1 className="break-words text-xl font-semibold">{file.title}</h1>
      <div>
        <Badge badge={file.badge} label="File status" />
      </div>
    </div>
  );
}

import { useMutation } from '@tanstack/react-query';
import type { FileVersion } from '@living-wiki/contracts';
import { saveVersion } from '../lib/download.js';
import { Button, ErrorNote } from '../components/ui.js';

/** What stands in for a preview: a sentence and the download. */
export function DownloadCard({ version, reason }: { version: FileVersion; reason: string }) {
  const save = useMutation({ mutationFn: () => saveVersion(version.id, version.fileName) });
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-line bg-surface p-4">
      <p className="text-sm">{reason}</p>
      <Button variant="secondary" onClick={() => save.mutate()} disabled={save.isPending}>
        Download {version.fileName}
      </Button>
      <ErrorNote error={save.error} />
    </div>
  );
}

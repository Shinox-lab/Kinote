import { api } from './api.js';
import { downloadFileName } from './fileUi.js';

/**
 * Saves a file version through the browser: the bytes are fetched with the session
 * (a link would need the token in the address), then handed to a temporary link.
 */
export async function saveVersion(versionId: string, fileName: string): Promise<void> {
  const { bytes, mimeType } = await api.versionFile(versionId);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = downloadFileName(fileName);
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

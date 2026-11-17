/**
 * The capture-file panel's logic, free of the DOM and the host bridge so it can be tested in Node: it uploads a
 * chosen file through the app-only tools (begin, chunks, finish) the host proxies to Kinote.
 */

/** The panel's view of a tools/call result. */
export interface ToolReply {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
export type CallServerTool = (name: string, args: Record<string, unknown>) => Promise<ToolReply>;

/** The file the person chose (a browser `File` fits). */
export interface PanelFile {
  name: string;
  type: string;
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

export interface PanelForm {
  notes: string;
  file_as: 'auto' | 'document' | 'updates';
  limit_to?: string | undefined;
}

export type UploadOutcome = { ok: true; receipt: string } | { ok: false; stage: 'begin' | 'upload' | 'finish'; message: string };

/** Tries per chunk: the first and two retries. */
const CHUNK_TRIES = 3;
const STOPPED = 'Upload stopped — try again';

export function chunkCount(size: number, chunkBytes: number): number {
  return Math.ceil(size / chunkBytes);
}

/** Base64 without Buffer (browser), in slices so a 1 MiB chunk does not overflow the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const textOf = (r: ToolReply) => r.content.map((c) => c.text ?? '').join('\n').trim();

/** Uploads `file` and captures it with `form`; `onProgress` gets bytes sent so far. Stops early when `signal` aborts. */
export async function uploadFile(
  file: PanelFile,
  call: CallServerTool,
  onProgress: (sent: number, total: number) => void,
  form: PanelForm,
  signal?: AbortSignal
): Promise<UploadOutcome> {
  if (file.size === 0) return { ok: false, stage: 'begin', message: 'This file is empty.' };

  let begin: ToolReply;
  try {
    begin = await call('kinote_upload_begin', { name: file.name, size: file.size, mime: file.type || 'application/octet-stream' });
  } catch {
    return { ok: false, stage: 'begin', message: STOPPED };
  }
  if (begin.isError) return { ok: false, stage: 'begin', message: textOf(begin) || STOPPED };
  const uploadId = String(begin.structuredContent?.upload_id ?? '');
  const chunkBytes = Number(begin.structuredContent?.chunk_bytes ?? 0);
  if (!uploadId || !chunkBytes) return { ok: false, stage: 'begin', message: STOPPED };

  const cancel = async () => {
    await call('kinote_upload_cancel', { upload_id: uploadId }).catch(() => undefined);
  };

  const total = file.size;
  for (let index = 0; index < chunkCount(total, chunkBytes); index++) {
    const start = index * chunkBytes;
    const end = Math.min(total, start + chunkBytes);
    const data = toBase64(new Uint8Array(await file.slice(start, end).arrayBuffer()));
    let sent = false;
    let refusal: string | null = null;
    for (let attempt = 0; attempt < CHUNK_TRIES && !sent; attempt++) {
      if (signal?.aborted) {
        await cancel();
        return { ok: false, stage: 'upload', message: 'Upload cancelled' };
      }
      try {
        const reply = await call('kinote_upload_chunk', { upload_id: uploadId, index, data });
        if (reply.isError) refusal = textOf(reply);
        else sent = true;
      } catch {
        refusal = null;
      }
    }
    if (!sent) {
      await cancel();
      return { ok: false, stage: 'upload', message: refusal || STOPPED };
    }
    onProgress(end, total);
  }

  let finish: ToolReply;
  try {
    finish = await call('kinote_upload_finish', {
      upload_id: uploadId,
      notes: form.notes,
      file_as: form.file_as,
      ...(form.limit_to ? { limit_to: form.limit_to } : {}),
    });
  } catch {
    return { ok: false, stage: 'finish', message: STOPPED };
  }
  if (finish.isError) return { ok: false, stage: 'finish', message: textOf(finish) || STOPPED };
  const receipt = typeof finish.structuredContent?.receipt === 'string' ? finish.structuredContent.receipt : textOf(finish);
  return { ok: true, receipt };
}

/** Splits text into plain runs and http(s) URLs, for rendering links that open through the host. */
export function linkify(text: string): Array<{ text: string } | { url: string }> {
  const out: Array<{ text: string } | { url: string }> = [];
  const re = /https?:\/\/[^\s<>"')]+/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    out.push({ url: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < text.length || out.length === 0) out.push({ text: text.slice(last) });
  return out;
}

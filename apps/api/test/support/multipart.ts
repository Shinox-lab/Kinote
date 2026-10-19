import { randomUUID } from 'node:crypto';

export interface MultipartPart {
  name: string;
  value?: string;
  filename?: string;
  type?: string;
  data?: Uint8Array | string;
}

/** A multipart/form-data body, as a browser or curl would send it. */
export function multipartBody(parts: MultipartPart[]): { payload: Buffer; contentType: string } {
  const boundary = `----lw-${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.filename !== undefined) head += `Content-Type: ${p.type ?? 'application/octet-stream'}\r\n`;
    head += '\r\n';
    chunks.push(Buffer.from(head), Buffer.from(p.data ?? p.value ?? ''), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** `app.inject` options for an upload: one file part plus optional text fields. */
export function uploadRequest(
  url: string,
  headers: Record<string, string>,
  file: { name: string; data: Uint8Array | string; type?: string } | null,
  fields: Record<string, string> = {}
) {
  const parts: MultipartPart[] = Object.entries(fields).map(([name, value]) => ({ name, value }));
  if (file) parts.push({ name: 'file', filename: file.name, type: file.type, data: file.data });
  const { payload, contentType } = multipartBody(parts);
  return { method: 'POST' as const, url, headers: { ...headers, 'content-type': contentType }, payload };
}

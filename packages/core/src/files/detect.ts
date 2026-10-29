import type { FileType } from '@kinote/contracts';

/** How a file's text is read: by the worker itself, by the extractor service, or not at all. */
export type FileHandling = 'text' | 'extractor' | 'stored';

export interface DetectedFile {
  type: FileType;
  /** Chosen by the server from the bytes; a claimed MIME type is never used. */
  mimeType: string;
  /** Canonical extension without the dot (`jpg` becomes `jpeg`, `markdown` becomes `md`). */
  extension: string;
  handling: FileHandling;
}

export type DetectResult = { ok: true; file: DetectedFile } | { ok: false; reason: 'empty' | 'unsupported' };

type Check = (bytes: Uint8Array) => boolean;

const startsWith = (bytes: Uint8Array, prefix: number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((b, i) => bytes[at + i] === b);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const hasAscii = (bytes: Uint8Array, s: string, at: number) => startsWith(bytes, ascii(s), at);

const noNul: Check = (b) => !b.subarray(0, 8192).includes(0);
const ftyp: Check = (b) => hasAscii(b, 'ftyp', 4);

function includesAscii(bytes: Uint8Array, s: string, limit: number): boolean {
  const end = Math.min(bytes.length, limit) - s.length;
  const needle = ascii(s);
  outer: for (let i = 0; i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const zipHas =
  (entry: string): Check =>
  (b) =>
    listZipEntries(b)?.includes(entry) ?? false;

interface Rule {
  type: FileType;
  mimeType: string;
  extension: string;
  handling: FileHandling;
  check: Check;
}

const OOXML = 'application/vnd.openxmlformats-officedocument';
const rule = (
  type: FileType,
  extension: string,
  mimeType: string,
  handling: FileHandling,
  check: Check
): Rule => ({ type, extension, mimeType, handling, check });

/** The one table of what may be uploaded, keyed by the (lower-case) extension of the file name. */
const RULES: Record<string, Rule> = {
  pdf: rule('pdf', 'pdf', 'application/pdf', 'extractor', (b) => includesAscii(b, '%PDF-', 1024)),
  docx: rule('docx', 'docx', `${OOXML}.wordprocessingml.document`, 'extractor', zipHas('word/document.xml')),
  xlsx: rule('xlsx', 'xlsx', `${OOXML}.spreadsheetml.sheet`, 'extractor', zipHas('xl/workbook.xml')),
  pptx: rule('pptx', 'pptx', `${OOXML}.presentationml.presentation`, 'extractor', zipHas('ppt/presentation.xml')),
  csv: rule('csv', 'csv', 'text/csv', 'text', noNul),
  txt: rule('txt', 'txt', 'text/plain', 'text', noNul),
  md: rule('md', 'md', 'text/markdown', 'text', noNul),
  markdown: rule('md', 'md', 'text/markdown', 'text', noNul),
  png: rule('png', 'png', 'image/png', 'extractor', (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  jpg: rule('jpeg', 'jpeg', 'image/jpeg', 'extractor', (b) => startsWith(b, [0xff, 0xd8, 0xff])),
  jpeg: rule('jpeg', 'jpeg', 'image/jpeg', 'extractor', (b) => startsWith(b, [0xff, 0xd8, 0xff])),
  gif: rule('gif', 'gif', 'image/gif', 'extractor', (b) => hasAscii(b, 'GIF87a', 0) || hasAscii(b, 'GIF89a', 0)),
  webp: rule('webp', 'webp', 'image/webp', 'extractor', (b) => hasAscii(b, 'RIFF', 0) && hasAscii(b, 'WEBP', 8)),
  mp3: rule('audio', 'mp3', 'audio/mpeg', 'stored', (b) => hasAscii(b, 'ID3', 0) || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)),
  wav: rule('audio', 'wav', 'audio/wav', 'stored', (b) => hasAscii(b, 'RIFF', 0) && hasAscii(b, 'WAVE', 8)),
  m4a: rule('audio', 'm4a', 'audio/mp4', 'stored', ftyp),
  ogg: rule('audio', 'ogg', 'audio/ogg', 'stored', (b) => hasAscii(b, 'OggS', 0)),
  mp4: rule('video', 'mp4', 'video/mp4', 'stored', ftyp),
  mov: rule('video', 'mov', 'video/quicktime', 'stored', ftyp),
  webm: rule('video', 'webm', 'video/webm', 'stored', (b) => startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])),
};

/** Looks like markup that a browser could run: refused whatever the file is called. */
function looksLikeMarkup(bytes: Uint8Array): boolean {
  let head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  head = head.replace(/^(ï»¿|﻿)/, '').trimStart().toLowerCase();
  return (
    head.startsWith('<svg') ||
    head.startsWith('<html') ||
    head.startsWith('<!doctype html') ||
    (head.startsWith('<?xml') && head.includes('<svg'))
  );
}

/**
 * Decides what an upload is from its bytes. The file name's extension must
 * agree with the bytes; SVG, HTML and XML are refused by name and by content.
 */
export function detectFileType(fileName: string, bytes: Uint8Array): DetectResult {
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  const dot = fileName.lastIndexOf('.');
  const extension = dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const found = RULES[extension];
  if (!found || looksLikeMarkup(bytes) || !found.check(bytes)) return { ok: false, reason: 'unsupported' };
  const { check: _check, ...file } = found;
  return { ok: true, file };
}

const ZIP_END = 0x06054b50;
const ZIP_ENTRY = 0x02014b50;
const MAX_ZIP_ENTRIES = 10_000;

/**
 * The entry names of a zip, read from its central directory only (nothing is
 * inflated, so a zip bomb costs nothing here). Null when the bytes are not a
 * well-formed zip, use zip64, or hold more than 10 000 entries.
 */
export function listZipEntries(bytes: Uint8Array): string[] | null {
  if (bytes.length < 22) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_535); i--) {
    if (view.getUint32(i, true) === ZIP_END) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const total = view.getUint16(end + 10, true);
  const size = view.getUint32(end + 12, true);
  let at = view.getUint32(end + 16, true);
  if (total === 0xffff || size === 0xffffffff || at === 0xffffffff || total > MAX_ZIP_ENTRIES) return null;
  if (at + size > bytes.length) return null;
  const names: string[] = [];
  const decoder = new TextDecoder('utf-8');
  for (let n = 0; n < total; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== ZIP_ENTRY) return null;
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    if (at + 46 + nameLength > bytes.length) return null;
    names.push(decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

const MAX_NAME_LENGTH = 200;

/**
 * A file name safe to store and show: whitespace runs become one space,
 * control characters go, path separators become `_`, at most 200 characters
 * (the extension is kept), `file` when nothing is left.
 */
export function cleanFileName(raw: string): string {
  const cleaned = raw
    .replace(/\s+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim();
  if (cleaned === '') return 'file';
  const chars = [...cleaned];
  if (chars.length <= MAX_NAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 12 ? [...cleaned.slice(dot)] : [];
  return [...chars.slice(0, MAX_NAME_LENGTH - ext.length), ...ext].join('');
}

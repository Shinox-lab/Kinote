import { describe, expect, it } from 'vitest';
import { cleanFileName, detectFileType, listZipEntries } from '../src/files/detect.js';

const enc = (s: string) => new TextEncoder().encode(s);
const bytes = (...n: number[]) => new Uint8Array(n);
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/** A zip of empty stored entries: local headers, central directory, end record. */
function makeZip(names: string[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const name of names) {
    const n = enc(name);
    const local = new Uint8Array(30 + n.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(26, n.length, true);
    local.set(n, 30);
    const central = new Uint8Array(46 + n.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, offset, true);
    central.set(n, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, names.length, true);
  ev.setUint16(10, names.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return cat(...locals, ...centrals, end);
}

const PDF = enc('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10);
const GIF = enc('GIF89a\u0001\u0000');
const WEBP = cat(enc('RIFF'), bytes(4, 0, 0, 0), enc('WEBPVP8 '));
const WAV = cat(enc('RIFF'), bytes(4, 0, 0, 0), enc('WAVEfmt '));
const MP3 = cat(enc('ID3'), bytes(4, 0, 0, 0, 0, 0, 0));
const FTYP = cat(bytes(0, 0, 0, 0x18), enc('ftypisom'), bytes(0, 0, 0, 0));
const OGG = cat(enc('OggS'), bytes(0, 2, 0, 0));
const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0);
const DOCX = makeZip(['[Content_Types].xml', 'word/document.xml']);
const XLSX = makeZip(['[Content_Types].xml', 'xl/workbook.xml']);
const PPTX = makeZip(['[Content_Types].xml', 'ppt/presentation.xml']);

describe('detectFileType', () => {
  const cases: Array<[string, string, Uint8Array, string, string, 'text' | 'extractor' | 'stored']> = [
    ['report.pdf', 'pdf', PDF, 'application/pdf', 'pdf', 'extractor'],
    ['memo.docx', 'docx', DOCX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx', 'extractor'],
    ['sheet.xlsx', 'xlsx', XLSX, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx', 'extractor'],
    ['deck.pptx', 'pptx', PPTX, 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx', 'extractor'],
    ['data.csv', 'csv', enc('a,b\n1,2\n'), 'text/csv', 'csv', 'text'],
    ['notes.txt', 'txt', enc('hello'), 'text/plain', 'txt', 'text'],
    ['readme.md', 'md', enc('# Hi'), 'text/markdown', 'md', 'text'],
    ['readme.markdown', 'md', enc('# Hi'), 'text/markdown', 'md', 'text'],
    ['scan.png', 'png', PNG, 'image/png', 'png', 'extractor'],
    ['photo.jpg', 'jpeg', JPEG, 'image/jpeg', 'jpeg', 'extractor'],
    ['photo.jpeg', 'jpeg', JPEG, 'image/jpeg', 'jpeg', 'extractor'],
    ['pic.gif', 'gif', GIF, 'image/gif', 'gif', 'extractor'],
    ['pic.webp', 'webp', WEBP, 'image/webp', 'webp', 'extractor'],
    ['song.mp3', 'audio', MP3, 'audio/mpeg', 'mp3', 'stored'],
    ['clip.wav', 'audio', WAV, 'audio/wav', 'wav', 'stored'],
    ['voice.m4a', 'audio', FTYP, 'audio/mp4', 'm4a', 'stored'],
    ['sound.ogg', 'audio', OGG, 'audio/ogg', 'ogg', 'stored'],
    ['movie.mp4', 'video', FTYP, 'video/mp4', 'mp4', 'stored'],
    ['movie.mov', 'video', FTYP, 'video/quicktime', 'mov', 'stored'],
    ['movie.webm', 'video', WEBM, 'video/webm', 'webm', 'stored'],
  ];

  it.each(cases)('accepts %s as %s', (name, type, data, mimeType, extension, handling) => {
    expect(detectFileType(name, data)).toEqual({ ok: true, file: { type, mimeType, extension, handling } });
  });

  it('is case-insensitive about the extension', () => {
    expect(detectFileType('REPORT.PDF', PDF)).toMatchObject({ ok: true, file: { type: 'pdf' } });
  });

  it('refuses an empty file', () => {
    expect(detectFileType('a.txt', new Uint8Array())).toEqual({ ok: false, reason: 'empty' });
  });

  it('refuses svg and html by name and by content, whatever the file is called', () => {
    expect(detectFileType('a.svg', enc('<svg xmlns="x"/>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.html', enc('<html></html>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.png', enc('<!DOCTYPE html><p>hi</p>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.txt', enc('﻿  \n<svg onload="x"/>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.md', enc('<?xml version="1.0"?><svg/>'))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.xml', enc('<a/>'))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses a zip named .docx that has no word/document.xml, and one that is not a zip', () => {
    expect(detectFileType('a.docx', makeZip(['readme.txt']))).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.docx', enc('not a zip at all'))).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses when the extension disagrees with the bytes', () => {
    expect(detectFileType('a.pdf', PNG)).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.xlsx', DOCX)).toEqual({ ok: false, reason: 'unsupported' });
    expect(detectFileType('a.mp4', WEBM)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('refuses legacy Office formats, programs and files with no extension', () => {
    for (const name of ['a.doc', 'a.xls', 'a.ppt', 'a.exe', 'a.zip', 'noext', 'report.pdf.exe']) {
      expect(detectFileType(name, PDF)).toEqual({ ok: false, reason: 'unsupported' });
    }
  });

  it('refuses a text file that holds binary', () => {
    expect(detectFileType('a.txt', bytes(0x68, 0x00, 0x69))).toEqual({ ok: false, reason: 'unsupported' });
  });
});

describe('listZipEntries', () => {
  it('lists the entry names without inflating anything', () => {
    expect(listZipEntries(makeZip(['a/b.xml', 'c.txt']))).toEqual(['a/b.xml', 'c.txt']);
  });

  it('answers null for bytes that are not a zip or are cut short', () => {
    expect(listZipEntries(enc('hello world'))).toBeNull();
    expect(listZipEntries(makeZip(['a.txt']).slice(0, 40))).toBeNull();
  });
});

describe('cleanFileName', () => {
  it('removes control characters and path separators', () => {
    const cleaned = cleanFileName('../../x\u0000.pdf');
    expect(cleaned).not.toMatch(/[\\/\u0000]/);
    expect(cleaned.endsWith('x.pdf')).toBe(true);
    expect(cleanFileName('a\\b/c\td.pdf')).toBe('a_b_c d.pdf');
  });

  it('cuts a long name to 200 characters and keeps the extension', () => {
    const cleaned = cleanFileName(`${'ä'.repeat(500)}.pdf`);
    expect([...cleaned].length).toBe(200);
    expect(cleaned.endsWith('.pdf')).toBe(true);
  });

  it('falls back to "file" for an empty name and keeps Unicode', () => {
    expect(cleanFileName('   ')).toBe('file');
    expect(cleanFileName('\u0001\u0002')).toBe('file');
    expect(cleanFileName('  報告 書.pdf ')).toBe('報告 書.pdf');
  });
});

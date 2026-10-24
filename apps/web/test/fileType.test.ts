import { describe, expect, test } from 'vitest';
import { fileType } from '../src/lib/fileType.js';

describe('fileType', () => {
  test('uses the extension first and shortens it to four characters', () => {
    expect(fileType('Policy.pdf')).toEqual({ label: 'PDF', tone: 'pdf' });
    expect(fileType('Plan.docx')).toEqual({ label: 'DOCX', tone: 'doc' });
    expect(fileType('Data.xlsx')).toEqual({ label: 'XLSX', tone: 'sheet' });
    expect(fileType('Deck.pptx')).toEqual({ label: 'PPTX', tone: 'slides' });
    expect(fileType('Notes.MD')).toEqual({ label: 'MD', tone: 'text' });
    expect(fileType('Photo.jpeg')).toEqual({ label: 'JPEG', tone: 'image' });
    expect(fileType('archive.tar.gz')).toEqual({ label: 'GZ', tone: 'other' });
  });

  test('falls back to the MIME type, then FILE', () => {
    expect(fileType('nameless', 'application/pdf')).toEqual({ label: 'PDF', tone: 'pdf' });
    expect(fileType('nameless', 'image/png')).toEqual({ label: 'IMG', tone: 'image' });
    expect(fileType('nameless', 'application/octet-stream')).toEqual({ label: 'FILE', tone: 'other' });
  });
});

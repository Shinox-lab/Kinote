/** The extension-derived identity of a file, used by the header, the tree, Home and search. */
export type FileTypeTone = 'pdf' | 'doc' | 'sheet' | 'slides' | 'text' | 'image' | 'other';

export interface FileType {
  /** Up to four characters, uppercase: PDF, DOCX, XLSX, MD, PNG, FILE. */
  label: string;
  tone: FileTypeTone;
}

const BY_MIME: Record<string, { label: string; tone: FileTypeTone }> = {
  'application/pdf': { label: 'PDF', tone: 'pdf' },
  'application/msword': { label: 'DOC', tone: 'doc' },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { label: 'DOCX', tone: 'doc' },
  'application/vnd.ms-excel': { label: 'XLS', tone: 'sheet' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { label: 'XLSX', tone: 'sheet' },
  'text/csv': { label: 'CSV', tone: 'sheet' },
  'application/vnd.ms-powerpoint': { label: 'PPT', tone: 'slides' },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { label: 'PPTX', tone: 'slides' },
  'text/markdown': { label: 'MD', tone: 'text' },
  'text/plain': { label: 'TXT', tone: 'text' },
};

const EXT_TONE: Record<string, FileTypeTone> = {
  pdf: 'pdf',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  rtf: 'doc',
  xls: 'sheet',
  xlsx: 'sheet',
  ods: 'sheet',
  csv: 'sheet',
  tsv: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  odp: 'slides',
  md: 'text',
  markdown: 'text',
  txt: 'text',
  json: 'text',
  yaml: 'text',
  yml: 'text',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  avif: 'image',
};

/** The type tile's label and tone: the file extension when it has one, else the MIME family, else FILE. */
export function fileType(name: string, mimeType?: string): FileType {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  const ext = match?.[1]?.toLowerCase();
  if (ext !== undefined) {
    return { label: ext.slice(0, 4).toUpperCase(), tone: EXT_TONE[ext] ?? 'other' };
  }
  if (mimeType?.startsWith('image/')) return { label: 'IMG', tone: 'image' };
  if (mimeType !== undefined && BY_MIME[mimeType] !== undefined) return BY_MIME[mimeType]!;
  return { label: 'FILE', tone: 'other' };
}

export const FILE_TYPE_TONE: Record<FileTypeTone, string> = {
  pdf: 'bg-danger-bg text-danger',
  doc: 'bg-review-bg text-review-text',
  sheet: 'bg-success-bg text-success',
  slides: 'bg-warn-bg text-warn-text',
  text: 'bg-hover text-muted',
  image: 'bg-accent-soft text-accent-text',
  other: 'bg-hover text-muted',
};

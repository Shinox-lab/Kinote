import { FILE_TYPE_TONE, fileType } from '../lib/fileType.js';

/**
 * A file's extension on a quiet tile. 34px in the file header, 20px in the tree
 * and rows; the type is text, so it never relies on colour alone.
 */
export function FileTypeTile({
  name,
  mimeType,
  size = 34,
}: {
  name: string;
  mimeType?: string;
  size?: 20 | 34;
}) {
  const type = fileType(name, mimeType);
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight ${FILE_TYPE_TONE[type.tone]} ${
        size === 34 ? 'size-[34px] text-[10px]' : 'size-5 text-[7px]'
      }`}
    >
      {type.label}
    </span>
  );
}

import { useEffect, useId, useRef, useState } from 'react';
import { PlusIcon } from './icons.js';

const ITEM = 'block w-full rounded px-2 py-1.5 text-left text-sm text-fg hover:bg-hover focus-visible:bg-hover';

/**
 * The "+" of a space or page row: add a new page there, or upload files into it.
 * Escape closes it and returns focus to the button; the file picker is a hidden input.
 */
export function AddMenu({
  label,
  className,
  onNewPage,
  onFiles,
}: {
  /** Names the button, e.g. "Docs" gives "Add to Docs". */
  label: string;
  className: string;
  onNewPage: () => void;
  onFiles: (files: File[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('button')?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    }
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <span className="relative">
      <button
        ref={button}
        type="button"
        aria-label={`Add to ${label}`}
        title="Add a page or upload files"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={className}
        onClick={() => setOpen((v) => !v)}
      >
        <PlusIcon />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label={`Add to ${label}`}
          className="absolute right-0 top-full z-30 mt-1 w-40 rounded-md border border-line bg-surface p-1 shadow-pop"
        >
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false);
              onNewPage();
            }}
          >
            New page
          </button>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false);
              input.current?.click();
            }}
          >
            Upload file
          </button>
        </div>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={`Upload files to ${label}`}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (picked.length > 0) onFiles(picked);
        }}
      />
    </span>
  );
}

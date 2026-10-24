import { useEffect, useRef, type ReactNode } from 'react';

const ITEM = 'block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-hover focus-visible:bg-hover';

/**
 * The menu a right-click opens: a small list of actions where the pointer was.
 * Escape or a click outside closes it, and the first item takes the focus so
 * the keyboard can walk it.
 */
export function ContextMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  /** Where the pointer was, in viewport pixels. */
  x: number;
  y: number;
  /** What the menu is about, e.g. "Leave policy". */
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('button')?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
    function onPointerDown(e: PointerEvent) {
      if (!menu.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menu}
      role="menu"
      aria-label={label}
      style={{ left: `${x}px`, top: `${y}px` }}
      className="fixed z-50 w-52 rounded-md border border-line bg-surface p-1 shadow-pop"
    >
      <p className="truncate px-2 pb-1 pt-0.5 text-[10.5px] font-medium uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

/** One action of a {@link ContextMenu}. `danger` marks a destructive action, like archiving. */
export function ContextMenuItem({
  label,
  onSelect,
  danger = false,
}: {
  label: string;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`${ITEM} ${danger ? 'text-danger hover:bg-danger-bg focus-visible:bg-danger-bg' : 'text-fg'}`}
      onClick={onSelect}
    >
      {label}
    </button>
  );
}

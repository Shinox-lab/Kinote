import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PageDetails, TreeResponse } from '@living-wiki/contracts';
import { api } from '../lib/api.js';
import { PAGE_ICONS } from '../lib/emoji.js';
import { useWorkspace } from '../lib/queries.js';
import { PageIcon } from './icons.js';
import { ErrorNote } from './ui.js';

const TREE_KEYS = ['tree', 'archived'];

function isTreeQuery(key: readonly unknown[]): boolean {
  return key[2] !== undefined && TREE_KEYS.includes(key[2] as string);
}

/**
 * The page's emoji, above the title. Clicking it opens the curated grid; the
 * page query and every cached tree row change at once, and a failed save puts
 * the old icon back. A viewer sees the emoji but no picker.
 */
export function PageIconPicker({
  pageId,
  icon,
  canEdit,
}: {
  pageId: string;
  icon: string | null;
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const { tenant } = useWorkspace();
  const queryClient = useQueryClient();
  const pageKey = ['t', tenant.id, 'page', pageId];

  const save = useMutation({
    mutationFn: (next: string | null) => api.updatePage(pageId, { icon: next }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: pageKey });
      const previousPage = queryClient.getQueryData<PageDetails>(pageKey);
      const previousTrees = queryClient
        .getQueriesData<TreeResponse>({ queryKey: ['t', tenant.id] })
        .filter(([key]) => isTreeQuery(key));

      queryClient.setQueryData<PageDetails>(pageKey, (old) => (old ? { ...old, icon: next } : old));
      queryClient.setQueriesData<TreeResponse>(
        { queryKey: ['t', tenant.id], predicate: (query) => isTreeQuery(query.queryKey) },
        (old) =>
          old
            ? { ...old, nodes: old.nodes.map((node) => (node.id === pageId ? { ...node, icon: next } : node)) }
            : old
      );
      return { previousPage, previousTrees };
    },
    onError: (_error, _next, context) => {
      if (!context) return;
      if (context.previousPage !== undefined) queryClient.setQueryData(pageKey, context.previousPage);
      for (const [key, data] of context.previousTrees) queryClient.setQueryData(key, data);
    },
    onSuccess: () => setOpen(false),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: pageKey });
      void queryClient.invalidateQueries({ queryKey: ['t', tenant.id, 'tree'] });
      void queryClient.invalidateQueries({ queryKey: ['t', tenant.id, 'archived'] });
    },
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const shown = (
    <span aria-hidden="true" className={icon === null ? 'text-muted' : undefined}>
      {icon ?? <PageIcon />}
    </span>
  );

  if (!canEdit) return <span className="flex size-[38px] items-center justify-center text-[30px] leading-none">{shown}</span>;

  return (
    <div
      ref={wrapper}
      className="relative"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-label="Change page icon"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={popoverId}
        onClick={() => setOpen((value) => !value)}
        className="flex size-[38px] items-center justify-center rounded-lg text-[30px] leading-none text-fg hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {shown}
      </button>
      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Choose a page icon"
          className="absolute left-0 top-full z-30 mt-1 w-[250px] rounded-lg border border-line bg-surface p-2 shadow-pop"
        >
          <div className="grid grid-cols-6 gap-0.5">
            {PAGE_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={`Use ${emoji}`}
                aria-pressed={icon === emoji}
                disabled={save.isPending}
                onClick={() => save.mutate(emoji)}
                className={`flex size-9 items-center justify-center rounded text-xl leading-none hover:bg-hover disabled:opacity-60 ${
                  icon === emoji ? 'bg-active' : ''
                }`}
              >
                <span aria-hidden="true">{emoji}</span>
              </button>
            ))}
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-line pt-1.5">
            <span className="px-1 text-xs text-muted">Page icon</span>
            <button
              type="button"
              disabled={save.isPending || icon === null}
              onClick={() => save.mutate(null)}
              className="rounded px-2 py-1 text-xs font-medium text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              Remove
            </button>
          </div>
          <ErrorNote error={save.error} />
        </div>
      )}
    </div>
  );
}

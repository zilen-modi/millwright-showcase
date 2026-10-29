import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * A small anchored popover: the trigger toggles it, Escape or a click outside closes it, and
 * focus returns to the trigger. Enough for filter and sort menus without another dependency.
 */
export function Menu({
  trigger,
  label,
  children,
  align = 'left',
  className,
}: {
  trigger: (open: boolean) => ReactNode;
  label: string;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer border-0 bg-transparent p-0"
      >
        {trigger(open)}
      </button>
      {open ? (
        <div
          role="menu"
          className={cn(
            'anim-fade-in absolute top-[calc(100%+4px)] z-40 min-w-[200px] rounded-[10px] border border-border bg-surface p-1 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
            className,
          )}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  checked,
  hint,
}: {
  children: ReactNode;
  onSelect: () => void;
  checked?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      onClick={onSelect}
      className="flex w-full cursor-pointer items-center gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] text-fg hover:bg-surface-2"
    >
      {checked !== undefined ? (
        <span
          aria-hidden
          className={cn(
            'flex h-3.5 w-3.5 flex-none items-center justify-center rounded-[4px] border text-[10px]',
            checked ? 'border-accent bg-accent text-on-accent' : 'border-border-strong',
          )}
        >
          {checked ? '✓' : ''}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint !== undefined ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </button>
  );
}

export function Chip({ active, children, className }: { active?: boolean; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-[3px] text-[12px] font-medium transition-colors',
        active
          ? 'border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] bg-accent-soft text-accent'
          : 'border-border-strong bg-surface text-fg-2 hover:bg-surface-2',
        className,
      )}
    >
      {children}
    </span>
  );
}

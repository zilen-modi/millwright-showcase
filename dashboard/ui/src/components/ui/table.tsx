import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** Bounded height + internal scroll so a long list doesn't push the page down, with a
 *  sticky header row — same behaviour as the legacy `.tablecard`. */
export function TableScroll({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('max-h-[420px] overflow-auto', className)} {...props} />;
}

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return <table className={cn('w-full border-collapse', className)} {...props} />;
}

export function Th({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        'sticky top-0 z-[1] whitespace-nowrap border-b border-border bg-surface px-3 py-2.5',
        'text-left text-[11px] font-bold uppercase tracking-[.04em] text-muted',
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('border-b border-grid px-3 py-2.5 align-middle text-[13px]', className)} {...props} />
  );
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={cn('transition-colors hover:bg-surface-2', className)} {...props} />;
}

export const numCell = 'text-right tabular-nums whitespace-nowrap';

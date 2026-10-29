import { cn } from '@/lib/utils';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className={cn(
        'inline-block h-[11px] w-[11px] shrink-0 rounded-full border-2 border-current border-r-transparent anim-spin',
        className,
      )}
    />
  );
}

export function LiveDot({ className }: { className?: string }) {
  return <span aria-hidden className={cn('inline-block h-[7px] w-[7px] rounded-full bg-accent anim-pulse', className)} />;
}

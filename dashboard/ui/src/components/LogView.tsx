import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

/** Terminal-style log pane that follows the tail unless the operator has scrolled up. */
export function LogView({
  lines,
  className,
  empty = 'No log output yet.',
  label,
}: {
  lines: string[];
  className?: string;
  empty?: string;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div
      ref={ref}
      role="log"
      aria-label={label}
      aria-live="polite"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        'overflow-auto rounded-[9px] bg-log-bg px-3.5 py-3 font-mono text-[11.5px] leading-[1.55]',
        'text-log-fg whitespace-pre-wrap break-words',
        className,
      )}
    >
      {lines.length === 0 ? (
        <span className="text-muted">{empty}</span>
      ) : (
        lines.map((line, i) => (
          <span key={i} className="block">
            {line}
          </span>
        ))
      )}
    </div>
  );
}

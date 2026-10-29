import { ExternalLink, Maximize2, Minimize2, Star, X } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useV2 } from '../data';

export interface PaneCtx { expanded: boolean; toggleExpand: () => void; close: () => void }
export const ThreadPaneContext = createContext<PaneCtx>({ expanded: false, toggleExpand: () => {}, close: () => {} });

const iconBtn = 'flex h-7 w-7 cursor-pointer items-center justify-center rounded-[7px] border-0 bg-transparent text-fg-2 hover:bg-surface-2 hover:text-fg';

export function ThreadHeader({
  title,
  subtitle,
  starId,
  links = [],
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  starId?: string;
  links?: { href: string; label: string; icon?: ReactNode }[];
  children?: ReactNode;
}) {
  const { expanded, toggleExpand, close } = useContext(ThreadPaneContext);
  const { starred, toggleStar } = useV2();
  const on = starId ? starred.has(starId) : false;
  return (
    <header className="border-b border-border px-4 pt-3 pb-2.5">
      <div className="flex items-center gap-1.5">
        <h2 className="m-0 min-w-0 flex-1 truncate text-[15px] font-bold">{title}</h2>
        {links.map((l) => (
          <a key={l.href} href={l.href} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-[7px] px-1.5 py-1 text-[12px] font-semibold text-accent hover:bg-surface-2">
            {l.icon || <ExternalLink size={12} aria-hidden />}{l.label}
          </a>
        ))}
        {starId ? (
          <Tooltip label={on ? 'Unstar' : 'Star'}>
            <button type="button" aria-pressed={on} aria-label={on ? 'Unstar' : 'Star'} onClick={() => toggleStar(starId)} className={cn(iconBtn, on && 'text-warning')}>
              <Star size={15} aria-hidden fill={on ? 'currentColor' : 'none'} />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip label={expanded ? 'Back to the side pane' : 'Full width'}>
          <button type="button" aria-label={expanded ? 'Shrink the thread' : 'Expand the thread'} onClick={toggleExpand} className={iconBtn}>
            {expanded ? <Minimize2 size={15} aria-hidden /> : <Maximize2 size={15} aria-hidden />}
          </button>
        </Tooltip>
        <Tooltip label="Close (Esc)">
          <button type="button" aria-label="Close the thread" onClick={close} className={iconBtn}><X size={16} aria-hidden /></button>
        </Tooltip>
      </div>
      {subtitle ? <p className="m-0 mt-0.5 text-[13px] leading-snug text-fg-2">{subtitle}</p> : null}
      {children}
    </header>
  );
}

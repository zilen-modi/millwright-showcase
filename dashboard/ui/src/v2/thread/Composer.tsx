import { CornerDownLeft } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { resolve, suggest, type Command } from '../commands';

/**
 * The thread's message box. A `/command` runs that action; plain text is notes for the
 * obvious command (continue, else replan) - the way a reply in a thread reads. Unavailable
 * commands are still listed, greyed, with the reason, so nothing silently disappears.
 */
export function Composer({
  commands,
  onRun,
  placeholder,
}: {
  commands: Command[];
  onRun: (command: Command, args: string) => Promise<unknown> | unknown;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const options = suggest(text, commands);

  useEffect(() => { setActive(0); }, [text]);
  // `/` anywhere outside a field focuses the composer, like Slack's message box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== '/' || el.closest('input, textarea, select, [role="dialog"]')) return;
      e.preventDefault();
      box.current?.focus();
      setText((t) => t || '/');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pick = (c: Command) => { setText(`/${c.name}${c.takesNotes ? ' ' : ''}`); setError(null); box.current?.focus(); };

  const submit = async () => {
    const r = resolve(text, commands);
    if ('error' in r) { setError(r.error); return; }
    setBusy(true);
    try {
      await onRun(r.command, r.args);
      setText('');
      setError(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative border-t border-border bg-surface p-3">
      {options.length ? (
        <ul role="listbox" aria-label="Commands" className="absolute right-3 bottom-[calc(100%-4px)] left-3 z-20 m-0 max-h-[260px] list-none overflow-y-auto rounded-[10px] border border-border bg-surface p-1 shadow-pop">
          {options.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === active} aria-disabled={!!c.disabledReason}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); pick(c); }}
                className={cn(
                  'flex w-full cursor-pointer items-baseline gap-2 rounded-[7px] border-0 bg-transparent px-2 py-1.5 text-left',
                  i === active ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span className={cn('font-mono text-[12.5px] font-semibold', c.disabledReason ? 'text-muted' : 'text-accent')}>/{c.name}</span>
                <span className={cn('min-w-0 flex-1 truncate text-[12.5px]', c.disabledReason ? 'text-muted' : 'text-fg')}>{c.label}</span>
                <span className="max-w-[55%] truncate text-[11px] text-muted">{c.disabledReason || (c.takesNotes ? 'takes notes' : '')}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={cn('flex items-end gap-2 rounded-[10px] border bg-page px-3 py-2 focus-within:border-accent', error ? 'border-critical' : 'border-border-strong')}>
        <textarea
          ref={box}
          value={text}
          rows={1}
          disabled={busy}
          onChange={(e) => { setText(e.target.value); if (error) setError(null); }}
          onKeyDown={(e) => {
            if (options.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
            } else if (options.length && (e.key === 'Tab' || (e.key === 'Enter' && !text.includes(' ')))) {
              e.preventDefault();
              pick(options[active]);
            } else if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            } else if (e.key === 'Escape') {
              setText(''); setError(null); box.current?.blur();
            }
          }}
          placeholder={placeholder || 'Type / for commands'}
          aria-label="Message or command"
          aria-invalid={error ? true : undefined}
          className="max-h-[160px] min-h-[22px] flex-1 resize-none border-0 bg-transparent p-0 text-[13.5px] leading-snug text-fg outline-none placeholder:text-muted"
          style={{ height: 'auto' }}
          onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${Math.min(160, t.scrollHeight)}px`; }}
        />
        <button
          type="button"
          aria-label="Send"
          disabled={busy || !text.trim()}
          onClick={() => void submit()}
          className="flex h-7 w-7 flex-none cursor-pointer items-center justify-center rounded-[7px] border-0 bg-accent text-on-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CornerDownLeft size={14} aria-hidden />
        </button>
      </div>
      <p role={error ? 'alert' : undefined} className={cn('mt-1.5 mb-0 text-[11.5px]', error ? 'font-semibold text-critical' : 'text-muted')}>
        {error || (
          <>
            {commands.filter((c) => !c.disabledReason).slice(0, 6).map((c) => (
              <button key={c.name} type="button" onClick={() => pick(c)} className="mr-2 cursor-pointer border-0 bg-transparent p-0 font-mono text-muted hover:text-accent">/{c.name}</button>
            ))}
            · Enter to send, Shift+Enter for a new line
          </>
        )}
      </p>
    </div>
  );
}

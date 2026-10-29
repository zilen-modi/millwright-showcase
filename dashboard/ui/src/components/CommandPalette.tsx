import { useEffect, useMemo, useState } from 'react';
import { Command } from 'cmdk';
import { useNavigate } from 'react-router-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useBoard } from '@/hooks/board';
import { useRuns } from '@/hooks/runs';
import { useTheme } from '@/hooks/useTheme';
import { parseTicketKey } from '@/lib/api';
import { money } from '@/lib/format';
import { phaseStyle } from '@/lib/phase';

/**
 * ⌘K / Ctrl-K command palette — launch a ticket, jump to one, pause, switch route or theme.
 * cmdk gives the combobox roles, active-descendant wiring and type-ahead; Radix Dialog gives
 * the focus trap and restore. The panel has never had a keyboard-first path before.
 */
export function CommandPalette({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
}) {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  const { state } = useBoard();
  const { run, setPaused } = useRuns();
  const { pref, setPref } = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const tickets = useMemo(() => state?.tickets || [], [state]);
  const typedKey = parseTicketKey(query);
  const paused = state?.automation.paused ?? false;

  const go = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-[rgba(10,12,16,.5)] backdrop-blur-[2px] anim-fade-in" />
        <DialogPrimitive.Content
          aria-label="Command palette"
          className="fixed left-1/2 top-[14vh] z-50 w-[min(560px,94vw)] -translate-x-1/2 overflow-hidden rounded-panel border border-border bg-surface shadow-drawer anim-fade-in focus:outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search tickets and run commands. Press Escape to close.
          </DialogPrimitive.Description>
          <Command loop label="Command palette">
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Type a ticket key, or a command…"
              className="w-full border-0 border-b border-border bg-transparent px-4 py-3.5 text-sm text-fg placeholder:text-muted focus:outline-none"
            />
            <Command.List className="max-h-[52vh] overflow-y-auto p-1.5">
              <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">
                No match. Paste a ticket key to launch a run.
              </Command.Empty>

              {typedKey ? (
                <Command.Group heading="Launch" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.05em] [&_[cmdk-group-heading]]:text-muted">
                  <Item onSelect={() => go(() => void run(typedKey, 'plan'))}>
                    Plan <Mono>{typedKey}</Mono> <Hint>stops at the plan gate — no code, no PR</Hint>
                  </Item>
                  <Item onSelect={() => go(() => void run(typedKey, 'review'))}>
                    Review <Mono>{typedKey}</Mono> <Hint>full pipeline; PR only if the receipt verifies</Hint>
                  </Item>
                </Command.Group>
              ) : null}

              <Command.Group heading="Tickets" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.05em] [&_[cmdk-group-heading]]:text-muted">
                {tickets.slice(0, 60).map((t) => (
                  <Item
                    key={t.key}
                    value={`${t.key} ${t.summary}`}
                    onSelect={() => go(() => navigate(`/board?ticket=${encodeURIComponent(t.key)}`))}
                  >
                    <span
                      aria-hidden
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ ...phaseStyle(t.phase || t.column), background: 'var(--ph)' }}
                    />
                    <Mono>{t.key}</Mono>
                    <span className="min-w-0 flex-1 truncate">{t.summary}</span>
                    {t.running ? <Hint>running</Hint> : t.costUsd ? <Hint>{money(t.costUsd)}</Hint> : null}
                  </Item>
                ))}
              </Command.Group>

              <Command.Group heading="Panel" className="[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10.5px] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[.05em] [&_[cmdk-group-heading]]:text-muted">
                <Item onSelect={() => go(() => void setPaused(!paused))}>
                  {paused ? 'Resume Millwright' : 'Pause Millwright'}{' '}
                  <Hint>{paused ? 'accept new runs again' : 'cancel active runs and block new ones'}</Hint>
                </Item>
                <Item onSelect={() => go(() => navigate('/'))}>Go to Console</Item>
                <Item onSelect={() => go(() => navigate('/board'))}>Go to Board</Item>
                <Item onSelect={() => go(() => navigate('/cost'))}>Go to Cost</Item>
                <Item onSelect={() => go(() => navigate('/pr-review'))}>Go to PR review</Item>
                <Item onSelect={() => go(() => navigate('/config'))}>Go to Config</Item>
                <Item onSelect={() => go(() => setPref(pref === 'dark' ? 'light' : 'dark'))}>
                  Switch to {pref === 'dark' ? 'light' : 'dark'} theme
                </Item>
                <Item onSelect={() => go(() => setPref('system'))}>Follow the OS theme</Item>
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Item({
  children,
  onSelect,
  value,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  value?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg-2 data-[selected=true]:bg-accent-soft data-[selected=true]:text-fg"
    >
      {children}
    </Command.Item>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-xs font-bold text-accent">{children}</span>
);
const Hint = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted">{children}</span>
);

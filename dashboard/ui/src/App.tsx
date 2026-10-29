import { useState } from 'react';
import { Command, Monitor, Moon, Settings, Sun } from 'lucide-react';
import { NavLink, Outlet, useMatch } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { CommandPalette } from '@/components/CommandPalette';
import { useStreamStatus } from '@/hooks/stream';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Console', end: true },
  { to: '/board', label: 'Board', end: false },
  { to: '/cost', label: 'Cost', end: false },
  { to: '/pr-review', label: 'Review', end: false },
];

export function App() {
  const { pref, resolved, toggle } = useTheme();
  const connected = useStreamStatus();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Resolved with a hook rather than NavLink's `className` callback: this link is wrapped
  // in a Tooltip, and Radix's `asChild` merges props by string-concatenating className —
  // which stringifies a FUNCTION into the class attribute. The mangled source still
  // contributed whitespace-separated tokens (border, rounded-[9px]) so the button looked
  // almost right, while `flex` stayed glued to a backtick and never applied, leaving the
  // icon uncentred in a block-display box and the active state permanently dead.
  const configActive = useMatch('/config') !== null;
  const ThemeIcon = pref === 'system' ? Monitor : pref === 'dark' ? Moon : Sun;

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-3 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-fg focus:shadow-pop"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-surface/92 px-4 py-2.5 backdrop-blur">
        <h1 className="m-0 text-[15px] font-bold tracking-[-.01em] text-fg">
          Millwright <span className="font-normal text-muted">· control panel</span>
        </h1>

        <nav aria-label="Panel sections" className="flex flex-wrap gap-0.5">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                cn(
                  'rounded-lg px-2.5 py-1.5 text-[13px] font-semibold no-underline transition-colors',
                  isActive ? 'bg-accent-soft text-accent' : 'text-fg-2 hover:bg-surface-2 hover:text-fg',
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>

        <span className="flex-1" />

        <NavLink to="/v2" className="rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-accent-soft px-2.5 py-1 text-[12px] font-semibold text-accent no-underline hover:brightness-105">
          Try v2
        </NavLink>

        <span
          className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-muted"
          role="status"
          aria-live="polite"
        >
          <span
            aria-hidden
            className={cn(
              'h-[7px] w-[7px] rounded-full',
              connected ? 'bg-good anim-pulse' : 'bg-muted',
            )}
          />
          {connected ? 'live' : 'reconnecting…'}
        </span>

        <Tooltip label="Command palette (⌘K)">
          <Button size="icon" aria-label="Open the command palette" onClick={() => setPaletteOpen(true)}>
            <Command size={15} aria-hidden />
          </Button>
        </Tooltip>

        <Tooltip label={`Theme: ${pref}${pref === 'system' ? ` (${resolved})` : ''} — click to cycle`}>
          <Button size="icon" aria-label={`Theme: ${pref}. Cycle light, dark, system.`} onClick={toggle}>
            <ThemeIcon size={15} aria-hidden />
          </Button>
        </Tooltip>

        <Tooltip label="Config">
          <NavLink
            to="/config"
            aria-label="Config"
            className={cn(
              'flex h-[34px] w-[34px] items-center justify-center rounded-[9px] border no-underline transition-colors',
              configActive
                ? 'border-[color-mix(in_srgb,var(--accent)_40%,var(--border))] bg-accent-soft text-accent'
                : 'border-border bg-surface-2 text-fg-2 hover:text-fg',
            )}
          >
            <Settings size={15} aria-hidden />
          </NavLink>
        </Tooltip>
      </header>

      <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-4">
        <Outlet />
      </main>

      <CommandPalette open={paletteOpen} setOpen={setPaletteOpen} />
      <Toaster position="bottom-right" closeButton richColors={false} theme={resolved} />
    </>
  );
}

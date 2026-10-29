import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
const STORAGE_KEY = 'autopilot.theme';

interface ThemeCtx {
  /** What the operator chose. `system` means "follow prefers-color-scheme". */
  pref: ThemePref;
  /** What is actually on screen right now. */
  resolved: 'light' | 'dark';
  setPref: (p: ThemePref) => void;
  /** Cycle light → dark → system. */
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // The explicit attribute is the whole mechanism: panel.css's dark block is scoped
  // `:root:not([data-theme="light"])` under the media query and `:root[data-theme="dark"]`
  // unconditionally, so setting/removing this one attribute makes an explicit choice win
  // over the OS preference in BOTH directions.
  useEffect(() => {
    const root = document.documentElement;
    if (pref === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', pref);
    try {
      if (pref === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, pref);
    } catch { /* private mode — the attribute still applies for this session */ }
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => setPrefState(p), []);
  const resolved: 'light' | 'dark' = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;
  const toggle = useCallback(() => {
    setPrefState((p) => (p === 'light' ? 'dark' : p === 'dark' ? 'system' : 'light'));
  }, []);

  const value = useMemo(() => ({ pref, resolved, setPref, toggle }), [pref, resolved, setPref, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}

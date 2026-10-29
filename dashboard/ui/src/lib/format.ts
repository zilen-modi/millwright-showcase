export const JIRA_BASE = 'https://acme.atlassian.net/browse/';

export function money(n: number | null | undefined) {
  return '$' + (Number(n) || 0).toFixed(2);
}

export function tokens(n: number | null | undefined) {
  return (Number(n) || 0).toLocaleString();
}

/** True when a finished run should read as a failure. Prefers the server's `status` (which
 * accounts for no-op runs that exit 0); falls back to the exit code when it is absent. */
export function runFailed(e: { code: number; status?: string }) {
  return e.status ? e.status !== 'success' : Number(e.code) !== 0;
}

/** The `— run … —` line appended to a log pane when a run ends. */
export function runEndLine(e: { mode: string; code: number; status?: string; failure?: string | null }) {
  if (e.status === 'cancelled') return `— run ${e.mode} cancelled — ${e.failure || 'cancelled'} —`;
  if (runFailed(e)) return `— run ${e.mode} FAILED (code ${e.code}) — ${e.failure || 'see the log above'} —`;
  return `— run ${e.mode} ended (code ${e.code}) —`;
}

export function duration(sec: number | null | undefined) {
  const s = Number(sec) || 0;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function shortDate(s: string | null | undefined) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString().slice(0, 10);
}

export function dateTime(s: string | null | undefined) {
  if (!s) return '—';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString().slice(0, 16).replace('T', ' ');
}

export function clock(s: string | null | undefined) {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toTimeString().slice(0, 5);
}

/** Logs already on disk were written before the formatter dropped it, so every Bash line still
 * opens with a cd into the workspace - the same ~50 characters of noise before any command.
 * Strip it for display too, so historical logs read as well as new ones. Text the old
 * formatter had already clipped is gone from the file and cannot be recovered here. */
function stripLoggedCdPrefix(line: string): string {
  return line.replace(/^(\s*→ \w+ \()cd\s+("[^"]*"|'[^']*'|\S+)\s*&&\s*/, '$1');
}

/** Split a run log for LogView. Interior blank lines are kept - they are the only separator
 * between one `=== panel run ... ===` section and the next - while leading and trailing blanks
 * are dropped so the pane does not open on empty space. */
export function logLines(text: string | null | undefined): string[] {
  const lines = String(text ?? '').split('\n').map(stripLoggedCdPrefix);
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

// Rounds of one PR review on disk: pr-reviews/<ref>/ holds the current round's findings.json
// and verdicts.json, rounds/<n>/ holds each earlier one. Split out of server.mjs so the
// archive step - the thing that keeps one round's verdicts off the next round's findings - is
// tested against real files instead of trusted.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRows, previousForRun, settleInherited } from '../scripts/findings-lib.mjs';

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');

/** Archived round numbers, oldest first. */
export function reviewRounds(dir) {
  try {
    return readdirSync(join(dir, 'rounds'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => Number(d.name))
      .sort((a, b) => a - b);
  } catch { return []; }
}

/**
 * The rows for a review directory, or null when it has no structured findings at all.
 * Until a re-review writes its own findings, the last archived round is shown, marked `stale`.
 */
export function loadFindingRows(dir) {
  const rounds = reviewRounds(dir);
  const roundDir = (n) => join(dir, 'rounds', String(n));
  const current = readJson(join(dir, 'findings.json'));
  const shown = current ? dir : rounds.length ? roundDir(rounds[rounds.length - 1]) : null;
  const findings = current || (shown ? readJson(join(shown, 'findings.json')) : null);
  if (!findings) return null;
  const prevRound = current ? rounds[rounds.length - 1] : rounds[rounds.length - 2];
  const state = buildRows({
    findings,
    verdicts: readJson(join(shown, 'verdicts.json')),
    triage: readJson(join(dir, 'triage.json')),
    previous: prevRound ? readJson(join(roundDir(prevRound), 'findings.json')) : null,
  });
  return {
    ...state,
    round: current ? rounds.length + 1 : rounds[rounds.length - 1],
    previousRound: prevRound ?? null,
    stale: !current,
  };
}

/**
 * Start a new round: settle inherited triage onto this round's fingerprints, MOVE its findings
 * and verdicts into rounds/<n>/, and leave previous-findings.json for the run to link against.
 * Moving rather than copying is the point - a verdicts.json left behind would be read against
 * the next round's renumbered ids. review.md stays put (copied, not moved): the drawer's
 * "report below is from an earlier run" notes rely on it. Returns the archived round or null.
 */
export function archiveReviewRound(dir) {
  if (!existsSync(join(dir, 'findings.json'))) return null;
  const state = loadFindingRows(dir);
  const round = state.round;
  const into = join(dir, 'rounds', String(round));
  mkdirSync(into, { recursive: true });
  writeJson(join(dir, 'triage.json'), settleInherited(state, readJson(join(dir, 'triage.json'))));
  for (const name of ['findings.json', 'verdicts.json']) {
    if (existsSync(join(dir, name))) renameSync(join(dir, name), join(into, name));
  }
  for (const name of ['review.md', 'quality-inputs.json']) {
    if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(into, name));
  }
  writeJson(join(dir, 'previous-findings.json'), previousForRun(state, round));
  return round;
}

// Pure reshaping/filtering logic for the duplication scan feeding quality-agent's
// reusability judgment — no filesystem, no I/O, unit-testable with vitest.
// dup-scan.mjs wraps `jscpd` (IO) and calls these; quality-agent decides whether a
// flagged fragment is a genuine extraction opportunity or coincidental similarity —
// this module only reshapes/filters what jscpd found, it never judges it.

/** Reshape jscpd's raw `--reporters json` output into a minimal, stable shape:
 * `{ duplicates: [{ files: [a, b], lines: [[startA,endA],[startB,endB]], tokens, fragment }] }`.
 * Tolerant of a missing/malformed `duplicates` array — returns an empty list rather
 * than throwing, since a report with genuinely zero duplicates looks the same on the
 * wire as a malformed one, and both should read as "nothing flagged," not a crash. */
export function normalizeJscpdReport(raw) {
  const rawDuplicates = Array.isArray(raw?.duplicates) ? raw.duplicates : [];
  const duplicates = rawDuplicates
    .map((d) => {
      const firstFile = d?.firstFile?.name;
      const secondFile = d?.secondFile?.name;
      if (!firstFile || !secondFile) return null;
      return {
        files: [firstFile, secondFile],
        lines: [
          [d.firstFile.start, d.firstFile.end],
          [d.secondFile.start, d.secondFile.end],
        ],
        tokens: Number(d.tokens) || 0,
        fragment: typeof d.fragment === 'string' ? d.fragment : '',
      };
    })
    .filter(Boolean);
  return { duplicates };
}

/** Keep only duplicates that touch at least one of the changed files. jscpd may scan
 * a wider tree than the diff; without this filter, a pre-existing duplicate elsewhere
 * in the repo gets blamed on this PR. `changedFiles` paths must be comparable to
 * jscpd's `files[]` entries (same relative-path convention) — callers own that match. */
export function filterByChangedFiles(duplicates, changedFiles) {
  const changed = new Set(changedFiles || []);
  if (changed.size === 0) return [];
  return (duplicates || []).filter((d) => d.files.some((f) => changed.has(f)));
}

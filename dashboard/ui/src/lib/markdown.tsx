import { Fragment, type ReactNode } from 'react';

/**
 * Minimal markdown → React for the artifact viewer (plan / design / review / ticket).
 *
 * These documents are model-written and therefore untrusted. The legacy pages escaped to
 * an HTML string and used innerHTML; building React nodes instead means there is no HTML
 * string anywhere, so injection is structurally impossible rather than escaped-by-hand.
 *
 * Behaviour matches the legacy renderer: wrapped continuation lines join into one
 * paragraph/list item, and every H2 becomes a collapsible section (a literal "Summary"
 * heading — or the first section when there is none — starts open) so a long report reads
 * as an outline instead of a wall of text.
 */

type Block =
  | { kind: 'h1' | 'h3'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };

interface Section {
  title: string | null;
  open: boolean;
  blocks: Block[];
}

function inline(text: string, keyBase: string): ReactNode[] {
  // Split on `code` and **bold** in one pass; everything else is plain text.
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={`${keyBase}-c${i}`}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
    i += 1;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function parse(md: string): Section[] {
  const sections: Section[] = [{ title: null, open: true, blocks: [] }];
  let current = sections[0];
  let buf: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;
  let sawSection = false;

  const flushParagraph = () => {
    if (!buf.length) return;
    const text = buf.join(' ');
    buf = [];
    if (list) list.items.push(text);
    else current.blocks.push({ kind: 'p', text });
  };
  const closeList = () => {
    flushParagraph();
    if (list) {
      current.blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    if (trimmed.startsWith('```')) {
      if (code === null) {
        closeList();
        code = [];
      } else {
        current.blocks.push({ kind: 'code', text: code.join('\n') });
        code = null;
      }
      continue;
    }
    if (code !== null) {
      code.push(raw);
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) {
        current.blocks.push({ kind: 'h1', level: 1, text });
      } else if (level === 2) {
        const open = /summary/i.test(text) || !sawSection;
        sawSection = true;
        current = { title: text, open, blocks: [] };
        sections.push(current);
      } else {
        current.blocks.push({ kind: 'h3', level, text });
      }
      continue;
    }

    const ul = trimmed.match(/^[-*]\s+(.*)$/);
    const ol = trimmed.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      const ordered = !ul;
      flushParagraph();
      if (!list || list.ordered !== ordered) {
        closeList();
        list = { ordered, items: [] };
      }
      buf.push((ul || ol)![1]);
      continue;
    }

    // GFM table — a `| ... |` row immediately followed by a `|---|---|` separator marks
    // the header; every `| ... |` row after that (until a non-table line) is a body row.
    // Without this case, table rows had nowhere else to land but the plain continuation-
    // line buffer below, and flushParagraph() joins that buffer with a single space — the
    // whole table collapsed into one run-on paragraph of pipe characters.
    if (isTableRow(trimmed) && i + 1 < lines.length && isTableSeparator(lines[i + 1].trim())) {
      closeList();
      const headers = splitTableRow(trimmed);
      const rows: string[][] = [];
      i += 2; // skip header + separator, resume from the first body row
      for (; i < lines.length; i++) {
        const bodyTrimmed = lines[i].trim();
        if (!isTableRow(bodyTrimmed)) break;
        rows.push(splitTableRow(bodyTrimmed));
      }
      i -= 1; // the for-loop's own increment re-checks the line that broke us out above
      current.blocks.push({ kind: 'table', headers, rows });
      continue;
    }

    if (trimmed === '') {
      closeList();
      continue;
    }
    buf.push(trimmed);
  }
  if (code !== null) current.blocks.push({ kind: 'code', text: code.join('\n') });
  closeList();
  return sections.filter((s) => s.title !== null || s.blocks.length);
}
function isTableRow(line: string): boolean {
  return /^\|.*\|$/.test(line);
}
function isTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line);
}
function splitTableRow(line: string): string[] {
  // GFM lets a cell contain a literal pipe as `\|` (e.g. a quoted grep pattern) — split
  // only on pipes NOT preceded by a backslash, then unescape `\|` back to `|` per cell.
  // A naive `.split('|')` shreds any cell containing an escaped pipe into extra columns.
  return line.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}
/**
 * Column widths in PIXELS, measured from the column's own content.
 *
 * Two things were wrong before. Percentages are relative to the container, so the same table
 * that reads fine on the Console page collapses in the 600px side drawer - a first column at
 * 8% is 45px there, and text wraps one letter per line. And a width picked from the column
 * COUNT cannot know that this table's lead column holds `handleConfirmTransferConfirm (:377)`
 * while its second holds only "leaks".
 *
 * So each column asks for what it needs: enough for its longest unbreakable token (otherwise
 * `overflow-wrap: anywhere` snaps identifiers mid-word), and enough for its typical cell up to
 * a sane prose target, then clamped. Absolute units mean a narrow container overflows and
 * `.table-wrap` scrolls horizontally instead of crushing every column toward zero.
 */
const PX_PER_CHAR = 6.6;
const COL_MIN_PX = 72;
const COL_MAX_PX = 340;
/** Past this, a cell is prose and should wrap over several lines rather than widen the table. */
const PROSE_TARGET_CHARS = 52;
/** Budget for the whole table. Wide enough that the drawer scrolls only a little, narrow
 *  enough that three prose columns do not add up to two screens of sideways scrolling.
 *  On a wide page `width: 100%` stretches the columns back out proportionally. */
const TABLE_TARGET_PX = 760;

/** Rendered width of a cell, not source width: `code` fences and ** markers are not drawn,
 *  and a [label](url) link renders as its label only. */
function plainCellText(cell: string): string {
  return cell
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .trim();
}

function columnWidths(headers: string[], rows: string[][]): number[] | null {
  const n = headers.length;
  if (n <= 1) return null;

  const clamp = (px: number) => Math.min(COL_MAX_PX, Math.max(COL_MIN_PX, px));
  // floor = the width below which `overflow-wrap: anywhere` starts snapping identifiers
  // mid-token; want = the width at which the column's typical cell reads comfortably.
  const floors: number[] = [];
  const wants: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const cells = [headers[i], ...rows.map((r) => r[i] ?? '')].map(plainCellText);
    let longestWord = 0;
    let longestCell = 0;
    for (const c of cells) {
      longestCell = Math.max(longestCell, c.length);
      for (const w of c.split(/\s+/)) longestWord = Math.max(longestWord, w.length);
    }
    floors.push(clamp(longestWord * PX_PER_CHAR));
    wants.push(clamp(Math.min(longestCell, PROSE_TARGET_CHARS) * PX_PER_CHAR));
  }

  // Over budget: give back slack proportionally, never below a column's floor. A column with
  // no slack (one long identifier and nothing else) keeps its width and the table scrolls -
  // breaking a symbol name across lines is worse than a scrollbar.
  const total = wants.reduce((a, w) => a + w, 0);
  if (total <= TABLE_TARGET_PX) return wants.map(Math.round);
  const slack = wants.map((w, i) => Math.max(0, w - floors[i]));
  const slackTotal = slack.reduce((a, w) => a + w, 0);
  if (slackTotal === 0) return wants.map(Math.round);
  const shrink = Math.min(total - TABLE_TARGET_PX, slackTotal) / slackTotal;
  return wants.map((w, i) => Math.round(w - slack[i] * shrink));
}

function renderBlocks(blocks: Block[], keyBase: string) {
  return blocks.map((b, i) => {
    const k = `${keyBase}-${i}`;
    if (b.kind === 'code') return <pre key={k}><code>{b.text}</code></pre>;
    if (b.kind === 'h1') return <h1 key={k}>{inline(b.text, k)}</h1>;
    if (b.kind === 'h3') {
      const Tag = (`h${Math.min(b.level, 6)}` as 'h3');
      return <Tag key={k}>{inline(b.text, k)}</Tag>;
    }
    if (b.kind === 'list') {
      const items = b.items.map((it, j) => <li key={`${k}-${j}`}>{inline(it, `${k}-${j}`)}</li>);
      return b.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
    if (b.kind === 'table') {
      const widths = columnWidths(b.headers, b.rows);
      // min-width is what makes the wrapper's overflow-x actually engage in a narrow container;
      // width:100% still lets the table stretch on a wide page.
      const minWidth = widths ? widths.reduce((a, w) => a + w, 0) : undefined;
      return (
        <div className="table-wrap" key={k}>
          <table style={minWidth ? { minWidth } : undefined}>
            {widths && (
              <colgroup>
                {widths.map((w, j) => <col key={`${k}-col${j}`} style={{ width: w }} />)}
              </colgroup>
            )}
            <thead>
              <tr>{b.headers.map((h, j) => <th key={`${k}-h${j}`}>{inline(h, `${k}-h${j}`)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((row, ri) => (
                <tr key={`${k}-r${ri}`}>
                  {row.map((cell, ci) => <td key={`${k}-r${ri}-c${ci}`}>{inline(cell, `${k}-r${ri}-c${ci}`)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <p key={k}>{inline(b.text, k)}</p>;
  });
}

export function Markdown({ source, empty = 'Not present.' }: { source: string | null | undefined; empty?: string }) {
  if (source == null || source.trim() === '') {
    return <p className="text-muted text-[13px]">{empty}</p>;
  }
  const sections = parse(source);
  return (
    <div className="md">
      {sections.map((s, i) => (
        <Fragment key={i}>
          {s.title === null ? (
            renderBlocks(s.blocks, `s${i}`)
          ) : (
            <details open={s.open}>
              <summary>{inline(s.title, `t${i}`)}</summary>
              {renderBlocks(s.blocks, `s${i}`)}
            </details>
          )}
        </Fragment>
      ))}
    </div>
  );
}

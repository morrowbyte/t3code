import { GHOSTTY_CELL_WIDE, type GhosttyRow } from "./core";

function searchCellText(cell: GhosttyRow["cells"][number]): string {
  return cell.wide === GHOSTTY_CELL_WIDE.spacerTail || cell.wide === GHOSTTY_CELL_WIDE.spacerHead
    ? ""
    : cell.text || " ";
}

export interface TerminalTextMatch {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

function columnAtOffset(row: GhosttyRow, offset: number): number {
  let length = 0;
  for (let column = 0; column < row.cells.length; column += 1) {
    length += searchCellText(row.cells[column]!).length;
    if (offset < length) return column;
  }
  return Math.max(0, row.cells.length - 1);
}

export function terminalTextMatches(
  rows: ReadonlyArray<GhosttyRow>,
  query: string,
): TerminalTextMatch[] {
  if (!query) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  const matches: TerminalTextMatch[] = [];
  for (let first = 0; first < rows.length;) {
    const segments: Array<{ row: number; start: number; end: number }> = [];
    let text = "";
    let next = first;
    do {
      const row = rows[next]!;
      const cellsText = row.cells.map(searchCellText).join("");
      const rowText = row.wrapsToNext ? cellsText : cellsText.trimEnd();
      segments.push({ row: next, start: text.length, end: text.length + rowText.length });
      text += rowText;
      next += 1;
    } while (next < rows.length && rows[next - 1]!.wrapsToNext);
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const startOffset = match.index;
      const endOffset = startOffset + match[0].length - 1;
      const start = segments.find((segment) => startOffset < segment.end)!;
      const end = segments.find((segment) => endOffset < segment.end)!;
      matches.push({
        start: { x: columnAtOffset(rows[start.row]!, startOffset - start.start), y: start.row },
        end: { x: columnAtOffset(rows[end.row]!, endOffset - end.start), y: end.row },
      });
      if (matches.length >= 10_000) return matches;
    }
    first = next;
  }
  return matches;
}

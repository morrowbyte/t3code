import type { FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";

interface KeyboardDiffFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
}
export interface KeyboardDiffSelection {
  readonly id: string;
  readonly range: SelectedLineRange;
}

export function firstDiffSelection(
  file: KeyboardDiffFile | undefined,
): KeyboardDiffSelection | null {
  const hunk = file?.fileDiff.hunks.find((entry) => entry.additionCount || entry.deletionCount);
  if (!file || !hunk) return null;
  const side = hunk.additionCount ? "additions" : "deletions";
  const line = side === "additions" ? hunk.additionStart : hunk.deletionStart;
  return { id: file.fileKey, range: { start: line, end: line, side } };
}

export function moveDiffSelection(
  files: readonly KeyboardDiffFile[],
  current: KeyboardDiffSelection | null,
  key: string,
  extend: boolean,
): KeyboardDiffSelection | null {
  const file = files.find((file) => file.fileKey === current?.id) ?? files[0];
  const selection = current?.id === file?.fileKey ? current : firstDiffSelection(file);
  if (!file || !selection) return null;
  if (key === "{" || key === "}") {
    const index = files.indexOf(file);
    for (
      let next = index + (key === "}" ? 1 : -1);
      next >= 0 && next < files.length;
      next += key === "}" ? 1 : -1
    ) {
      const target = firstDiffSelection(files[next]);
      if (target) return target;
    }
    return selection;
  }
  const range = selection.range;
  const side = range.endSide ?? range.side ?? "additions";
  const nextSide =
    key === "h" || key === "arrowleft"
      ? "deletions"
      : key === "l" || key === "arrowright"
        ? "additions"
        : side;
  const ranges = file.fileDiff.hunks
    .map((hunk) =>
      nextSide === "deletions"
        ? { start: hunk.deletionStart, count: hunk.deletionCount }
        : { start: hunk.additionStart, count: hunk.additionCount },
    )
    .filter((entry) => entry.count > 0);
  const line = range.end;
  let next: number | undefined;
  if (key === "[" || key === "]") {
    next =
      key === "]"
        ? ranges.find((entry) => entry.start > line)?.start
        : ranges.findLast((entry) => entry.start < line)?.start;
  } else if (
    ["j", "k", "arrowdown", "arrowup", "h", "l", "arrowleft", "arrowright"].includes(key)
  ) {
    const backwards = key === "k" || key === "arrowup";
    const forwards = key === "j" || key === "arrowdown";
    const candidate = backwards
      ? ranges.findLast((entry) => entry.start < line)
      : ranges.find((entry) => entry.start + entry.count - 1 >= line + (forwards ? 1 : 0));
    if (candidate)
      next = backwards
        ? Math.min(line - 1, candidate.start + candidate.count - 1)
        : Math.max(candidate.start, line + (forwards ? 1 : 0));
    else
      next = backwards
        ? ranges[0]?.start
        : ranges.at(-1)
          ? ranges.at(-1)!.start + ranges.at(-1)!.count - 1
          : undefined;
  } else return null;
  return next === undefined
    ? selection
    : {
        id: file.fileKey,
        range: {
          start: extend && nextSide === side ? range.start : next,
          end: next,
          side: nextSide,
        },
      };
}

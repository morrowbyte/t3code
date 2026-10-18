import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";

// md4c recognizes math spans after block syntax. Newlines inside TeX must not
// turn arithmetic signs into lists or an equality into a setext heading.
const nativeDisplayMathSource = (source: string) => {
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      result += char;
      if (source[index + 1] === "\r" && source[index + 2] === "\n") {
        result += " ";
        index += 2;
      } else if (index + 1 < source.length) {
        result += source[++index] === "\n" ? " " : source[index];
      }
    } else if (char === "%") {
      // A TeX comment consumes its newline, including inside \text{foo%\nbar}.
      while (index < source.length && !/[\r\n]/.test(source[index]!)) index += 1;
      if (source[index] === "\r" && source[index + 1] === "\n") index += 1;
    } else if (char === "\r" || char === "\n") {
      result += " ";
      if (char === "\r" && source[index + 1] === "\n") index += 1;
    } else result += char;
  }
  return result;
};

export const nativeMathFailureKey = (source: string, display: boolean) =>
  `${display ? "display" : "inline"}:${(display ? nativeDisplayMathSource(source) : source).trim()}`;

const literalMarkdown = (source: string) => source.replace(/[\\`*_[\]{}()<>#$|+.=~-]/g, "\\$&");

/** Only the native display copy changes; the message and selection/copy source stay original. */
export function prepareNativeMathMarkdown(
  source: string,
  streaming: boolean,
  failures: ReadonlySet<string> = new Set(),
): { markdown: string; pending: "display" | "inline" | null; display: boolean } {
  if (!source.includes("$")) return { markdown: source, pending: null, display: false };
  const protectedRanges: Array<{ start: number; end: number }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "code" || node.type === "inlineCode" || node.type === "image") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end });
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parseMarkdownDocument(source));
  let rangeIndex = 0;
  let markdown = "";
  let index = 0;
  let hasDisplay = false;
  while (index < source.length) {
    while (protectedRanges[rangeIndex] && protectedRanges[rangeIndex]!.end <= index)
      rangeIndex += 1;
    const protectedRange = protectedRanges[rangeIndex];
    if (protectedRange && index >= protectedRange.start) {
      markdown += source.slice(index, protectedRange.end);
      index = protectedRange.end;
      continue;
    }
    if (source[index] === "\\") {
      markdown += source.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (source[index] !== "$") {
      markdown += source[index++];
      continue;
    }
    const lineStart = source.lastIndexOf("\n", index - 1) + 1;
    const display =
      /^ {0,3}$/.test(source.slice(lineStart, index)) &&
      /^\$\$[\t ]*(?:\r?\n|$)/.test(source.slice(index));
    if (display) {
      const opening = /^\$\$[\t ]*(?:\r?\n|$)/.exec(source.slice(index))![0];
      const contentStart = index + opening.length;
      const closing = /^ {0,3}\$\$[\t ]*\r?$/m.exec(source.slice(contentStart));
      if (!closing) {
        return streaming
          ? { markdown, pending: "display", display: hasDisplay }
          : {
              markdown: markdown + literalMarkdown(source.slice(index)),
              pending: null,
              display: hasDisplay,
            };
      }
      const end = contentStart + closing.index + closing[0].length;
      const body = source.slice(contentStart, contentStart + closing.index);
      const original = source.slice(index, end);
      const finalBreak = /\r?\n$/.exec(body)?.[0] ?? "";
      const nativeBody = nativeDisplayMathSource(body.slice(0, body.length - finalBreak.length));
      markdown += failures.has(nativeMathFailureKey(body, true))
        ? literalMarkdown(original)
        : `${opening}${nativeBody}${finalBreak}${closing[0]}`;
      hasDisplay ||= !failures.has(nativeMathFailureKey(body, true));
      index = end;
      continue;
    }
    if (source[index + 1] === "$" || source[index - 1] === "$") {
      markdown += "\\$";
      index += 1;
      continue;
    }
    let closing = index + 1;
    while (closing < source.length && source[closing] !== "\n") {
      if (source[closing] === "\\") closing += 2;
      else if (source[closing] === "$") break;
      else closing += 1;
    }
    const body = source.slice(index + 1, closing);
    const closed = source[closing] === "$";
    if (
      closed &&
      body.length > 0 &&
      !/^\s|\s$/.test(body) &&
      !/\d/.test(source[closing + 1] ?? "") &&
      !/^[A-Z_][A-Z\d_]*[/\\]/.test(body) &&
      (!protectedRange || closing < protectedRange.start)
    ) {
      const original = source.slice(index, closing + 1);
      markdown += failures.has(nativeMathFailureKey(body, false))
        ? literalMarkdown(original)
        : original;
      index = closing + 1;
    } else if (!closed && closing >= source.length && /\\[a-zA-Z]+|[_^=]/.test(body)) {
      return streaming
        ? { markdown: markdown + "\u2007", pending: "inline", display: hasDisplay }
        : {
            markdown: markdown + literalMarkdown(source.slice(index)),
            pending: null,
            display: hasDisplay,
          };
    } else {
      markdown += "\\$";
      index += 1;
    }
  }
  return { markdown, pending: null, display: hasDisplay };
}

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { Root, RootContent } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm);

export type StreamableMarkdownSegment =
  | { kind: "markdown"; markdown: string; sourceOffset: number; referenceDefinitions?: string }
  | { kind: "visual"; code: string; closed: boolean; sourceOffset: number };

/** Use Markdown's code nodes so examples inside ordinary fences and HTML stay literal. */
export function splitStreamableUiMarkdown(markdown: string): StreamableMarkdownSegment[] {
  if (!markdown.includes("t3-ui")) {
    return [{ kind: "markdown", markdown, sourceOffset: 0 }];
  }
  const segments: StreamableMarkdownSegment[] = [];
  const definitions: string[] = [];
  let offset = 0;
  const visit = (node: Root | RootContent) => {
    if (node.type === "code" && node.lang === "t3-ui") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      const source = markdown.slice(start, end);
      const opening = /^(?:`{3,}|~{3,})/.exec(source)?.[0];
      if (!opening) return;
      const closing = /(?:\r\n|\r|\n)[ \t>]*(`{3,}|~{3,})[ \t]*$/.exec(source)?.[1];
      if (start > offset) {
        segments.push({
          kind: "markdown",
          markdown: markdown.slice(offset, start),
          sourceOffset: offset,
        });
      }
      segments.push({
        kind: "visual",
        code: node.value,
        closed:
          closing !== undefined && closing[0] === opening[0] && closing.length >= opening.length,
        sourceOffset: start,
      });
      offset = end;
    } else if (node.type === "definition") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        definitions.push(markdown.slice(start, end).replace(/^[ \t>]*>[ \t]?/gm, ""));
      }
    } else if ("children" in node) {
      node.children.forEach(visit);
    }
  };
  visit(parser.parse(markdown));
  if (offset < markdown.length || segments.length === 0) {
    segments.push({ kind: "markdown", markdown: markdown.slice(offset), sourceOffset: offset });
  }
  // Each native Markdown view needs the document's original reference context.
  // Keep the first definition first, even when a later segment redeclares it.
  if (definitions.length > 0 && segments.some((segment) => segment.kind === "visual")) {
    for (const segment of segments) {
      if (segment.kind === "markdown") segment.referenceDefinitions = definitions.join("\n\n");
    }
  }
  return segments;
}

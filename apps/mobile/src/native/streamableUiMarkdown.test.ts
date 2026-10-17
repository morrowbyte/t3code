import { describe, expect, it } from "vite-plus/test";
import { parseStreamableUi } from "@t3tools/shared/streamableUi";
import { splitStreamableUiMarkdown } from "./streamableUiMarkdown";
import remarkParse from "remark-parse";
import { unified } from "unified";

const record = JSON.stringify({ type: "metric", id: "depth", label: "Queue depth", value: 42 });

describe("native assistant visual fences", () => {
  it("keeps reference links working across native visual boundaries", () => {
    const markdown = `[Before][source]\n\n\`\`\`t3-ui\n${record}\n\`\`\`\n\n[After][source]\n\n[source]: https://example.com/measurements "Measurements"`;
    const segments = splitStreamableUiMarkdown(markdown);
    for (const segment of segments) {
      if (segment.kind !== "markdown") continue;
      const document = unified()
        .use(remarkParse)
        .parse(`${segment.referenceDefinitions}\n\n${segment.markdown}`);
      const paragraph = document.children.find((node) => node.type === "paragraph");
      expect(paragraph?.children[0]).toMatchObject({ type: "linkReference", identifier: "source" });
      expect(document.children.find((node) => node.type === "definition")).toMatchObject({
        url: "https://example.com/measurements",
        title: "Measurements",
      });
    }
  });
  it("keeps surrounding Markdown byte-for-byte and closes each visual independently", () => {
    const before = "# Result\n\nA **metric** with [context](https://example.com).\n\n";
    const between = "\n\nRemaining Markdown is still streaming.\n\n";
    expect(
      splitStreamableUiMarkdown(
        `${before}\`\`\`t3-ui\n${record}\n\`\`\`${between}~~~t3-ui\n${record}`,
      ),
    ).toEqual([
      { kind: "markdown", markdown: before, sourceOffset: 0 },
      { kind: "visual", code: record, closed: true, sourceOffset: before.length },
      { kind: "markdown", markdown: between, sourceOffset: before.length + record.length + 13 },
      {
        kind: "visual",
        code: record,
        closed: false,
        sourceOffset: before.length + record.length + 13 + between.length,
      },
    ]);
  });

  it.each([
    "Regular **Markdown** and `t3-ui` stay selectable.",
    `\`\`\`json\n${record}\n\`\`\``,
    `\`\`\`\`markdown\n\`\`\`t3-ui\n${record}\n\`\`\`\n\`\`\`\``,
    `    \`\`\`t3-ui\n    ${record}\n    \`\`\``,
    `<pre>\n\`\`\`t3-ui\n${record}\n\`\`\`\n</pre>`,
    "` ```t3-ui ` is an inline example.",
  ])("leaves ordinary code and Markdown unchanged: %s", (markdown) => {
    expect(splitStreamableUiMarkdown(markdown)).toEqual([
      { kind: "markdown", markdown, sourceOffset: 0 },
    ]);
  });

  it.each([
    [`~~~t3-ui\r\n${record}\r\n~~~~`, true],
    [`\`\`\`\`t3-ui\n${record}\n\`\`\``, false],
    [`\`\`\`t3-ui\n${record}\n~~~`, false],
    [`\`\`\`t3-ui\n${record}\n\`\`\` trailing`, false],
    [`> \`\`\`t3-ui\n> ${record}\n> \`\`\``, true],
    [`- \`\`\`t3-ui\n  ${record}\n  \`\`\``, true],
  ])("uses the actual fence marker and length for %s", (markdown, closed) => {
    const visual = splitStreamableUiMarkdown(markdown).find((segment) => segment.kind === "visual");
    expect(visual).toMatchObject({ closed });
  });

  it("never repairs an incomplete record at any streamed character boundary", () => {
    const prefix = `\`\`\`t3-ui\n${record}\n`;
    const next = JSON.stringify({ type: "metric", id: "rate", label: "Rate", value: -12.75 });
    for (let length = 0; length <= next.length; length++) {
      const visual = splitStreamableUiMarkdown(prefix + next.slice(0, length)).find(
        (segment) => segment.kind === "visual",
      );
      expect(visual?.kind).toBe("visual");
      if (visual?.kind !== "visual") continue;
      const streaming = parseStreamableUi(visual.code, true);
      expect(streaming.components).toHaveLength(length === next.length ? 2 : 1);
      expect(streaming.error).toBeUndefined();
      const cancelled = parseStreamableUi(visual.code, false);
      expect(cancelled.pending).toBe(false);
      expect(cancelled.components).toEqual(streaming.components);
    }
  });
});

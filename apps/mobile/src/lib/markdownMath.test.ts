import { describe, expect, it } from "vite-plus/test";
import { nativeMathFailureKey, prepareNativeMathMarkdown } from "./markdownMath";
import { parseMarkdownDocument } from "./markdownDocument";

describe("native math Markdown", () => {
  it("keeps closed display and inline TeX for the native engine during streaming and history", () => {
    const source = String.raw`Inline $\sqrt{n}$.

$$
(125\,\%+125\,\%)\times2{,}5=+625\,\%
$$

Markdown **after** the closed block.`;
    for (const streaming of [true, false])
      expect(prepareNativeMathMarkdown(source, streaming)).toEqual({
        markdown: source,
        pending: null,
        display: true,
      });
  });

  it("reserves an incomplete stream and restores the received original on Stop", () => {
    for (const tail of ["$$\n\\sqrt{n}", "$x_i=\\sqrt{n}"]) {
      expect(
        prepareNativeMathMarkdown(`Before ${tail.startsWith("$$") ? "\n\n" : ""}${tail}`, true)
          .pending,
      ).toBe(tail.startsWith("$$") ? "display" : "inline");
      const stopped = prepareNativeMathMarkdown(tail, false);
      const paragraph = parseMarkdownDocument(stopped.markdown).children[0];
      expect(paragraph).toMatchObject({
        type: "paragraph",
        children: [{ type: "text", value: tail }],
      });
      expect(stopped.pending).toBeNull();
    }
  });

  it("keeps prices, shell variables and escaped dollars literal without changing code", () => {
    const source = "Costs $5 and $10. Use $HOME/$PATH; \\$5. `echo $x$`\n\n```sh\n$HOME/$PATH\n```";
    const result = prepareNativeMathMarkdown(source, false);
    expect(result.markdown).toContain("Costs \\$5 and \\$10");
    expect(result.markdown).toContain("\\$HOME/\\$PATH");
    expect(result.markdown).toContain("`echo $x$`");
    expect(result.markdown).toContain("```sh\n$HOME/$PATH\n```");
    expect(result.pending).toBeNull();
  });

  it("shows the entire received expression after a native rendering error", () => {
    const source = "$\\unknown{a_b}$";
    const result = prepareNativeMathMarkdown(
      source,
      false,
      new Set([nativeMathFailureKey("\\unknown{a_b}", false)]),
    );
    expect(parseMarkdownDocument(result.markdown).children[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", value: source }],
    });
  });

  it("keeps an open code fence and its dollar delimiters literal", () => {
    const source = "```text\n$$\n\\sqrt{n}";
    expect(prepareNativeMathMarkdown(source, true)).toEqual({
      markdown: source,
      pending: null,
      display: false,
    });
  });

  it("keeps multiline TeX in one Markdown paragraph instead of lists and setext headings", () => {
    const expressions = [
      String.raw`0{,}020 \times 0{,}125
+ 0{,}080 \times 0{,}010
+ 0{,}010 \times 0{,}50
= 0{,}00830\ \text{USD}.`,
      String.raw`\text{Kosten pro korrekt erledigter Aufgabe}
=
\frac{\text{Kosten aller Versuche, Fallbacks, Tools und Laufzeit}}
{\text{Anzahl korrekt abgeschlossener Aufgaben}}.`,
    ];
    for (const expression of expressions) {
      const source = `$$\n${expression}\n$$`;
      for (const streaming of [true, false]) {
        const result = prepareNativeMathMarkdown(source, streaming);
        expect(parseMarkdownDocument(result.markdown).children.map((node) => node.type)).toEqual([
          "paragraph",
        ]);
        expect(result).toMatchObject({ display: true, pending: null });
      }
    }
  });

  it("keeps TeX row breaks and escaped percents while joining comments without adding text spaces", () => {
    const body = String.raw`\begin{aligned}
\text{foo% comment
bar} &= 25\% \\
&= x + y
\end{aligned}`;
    const result = prepareNativeMathMarkdown(`$$\n${body}\n$$`, false);
    expect(result.markdown).toBe(String.raw`$$
\begin{aligned} \text{foobar} &= 25\% \\ &= x + y \end{aligned}
$$`);
  });

  it("preserves list markers and setext lines literally in stopped or failed math", () => {
    const body = "x\n+ y\n- z\n=";
    for (const [source, failures] of [
      [`$$\n${body}`, new Set<string>()],
      [`$$\n${body}\n$$`, new Set([nativeMathFailureKey(body, true)])],
    ] as const) {
      const result = prepareNativeMathMarkdown(source, false, failures);
      const document = parseMarkdownDocument(result.markdown);
      expect(document.children.map((node) => node.type)).toEqual(["paragraph"]);
      expect(document.children[0]).toMatchObject({ children: [{ type: "text", value: source }] });
    }
  });
});

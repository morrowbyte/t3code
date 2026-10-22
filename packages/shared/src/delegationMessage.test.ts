import { describe, expect, it } from "vite-plus/test";
import { firstDelegationParagraph } from "./delegationMessage.ts";

describe("delegation communication", () => {
  it.each(["\n", "\r\n"])("keeps the complete first paragraph with %j line endings", (newline) => {
    const paragraph = `Kurz: Prüfe den vollständigen Auftrag. ${"Weitere Wörter. ".repeat(80)}${newline}Diese Zeile gehört noch dazu.`;
    expect(
      firstDelegationParagraph(
        `${paragraph}${newline}\t ${newline}Technik:${newline}Privater Detailauftrag`,
      ),
    ).toBe(paragraph);
    expect(firstDelegationParagraph(paragraph)).toBe(paragraph);
  });

  it("ignores surrounding whitespace without stripping a message prefix or changing its text", () => {
    expect(
      firstDelegationParagraph("\n\nKurz: Bitte prüfen.\nWeiterhin derselbe Absatz.\n\nDetails\n"),
    ).toBe("Kurz: Bitte prüfen.\nWeiterhin derselbe Absatz.");
  });
});

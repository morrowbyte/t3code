import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";
import { T3_CODE_VISUAL_INSTRUCTIONS } from "./orchestrationInstructions.ts";
import { parseStreamableUi } from "@t3tools/shared/streamableUi";

describe("buildRuntimeInstructions", () => {
  it("asks senders for structured handoffs without rewriting originals or adding model calls", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions.match(/<agent_messages>/g)).toHaveLength(1);
    expect(instructions).toContain('Start with "Kurz: "');
    expect(instructions).toContain('"Ergebnis:", "Offen:", "Nächster Schritt:"');
    expect(instructions).toContain("The tool supplies sender/target metadata");
    expect(instructions).toContain("Do not add a second model call");
    expect(instructions).toContain("rewrite stored history");
    expect(instructions).toContain("<tool_output_selection>");
    expect(instructions).toContain("<response_audience>");
  });

  it.each(["Cursor", "Muse", "Grok", "OpenCode", "Claude Code"])(
    "provides %s the exact valid protocol even without T3 MCP context",
    (harness) => {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain(T3_CODE_VISUAL_INSTRUCTIONS);
      const examples = instructions.split("\n").filter((line) => line.startsWith('{"type":'));
      const parsed = parseStreamableUi(examples.join("\n"), false);
      expect(parsed.error).toBeUndefined();
      expect(parsed.components.map((component) => component.type)).toEqual([
        "metric",
        "table",
        "chart",
        "chart",
        "cards",
        "timeline",
        "workflow",
        "report",
        "uml",
      ]);
    },
  );

  it("omits a duplicate protocol only when the caller already attached it", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      visualProtocolAttached: true,
    });
    expect(instructions).toContain("use relevant native t3-ui visuals by default");
    expect(instructions).not.toContain(T3_CODE_VISUAL_INSTRUCTIONS);
  });
  it("defaults useful human explanations to visuals without requiring a visual prompt", () => {
    for (const harness of ["Codex", "Claude Code", "Cursor"]) {
      const instructions = buildRuntimeInstructions({ harness });
      expect(instructions).toContain("use relevant native t3-ui visuals by default");
      expect(instructions).toContain('Do not wait for words such as "visualize"');
      expect(instructions).toContain("verified facts or clearly identified calculations");
      expect(instructions).toContain("never invent measurements");
      expect(instructions).toContain(
        "Email drafts, simple facts and tasks without a useful visual",
      );
      expect(instructions).toContain("should remain concise text");
    }
  });

  it("uses intended audience rather than MCP attribution and renders only at the final agent", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("not the message actor or transport");
    expect(instructions).toContain("A thread created by an agent or MCP can still request");
    expect(instructions).toContain("Internal agent-to-agent handoffs and steering messages");
    expect(instructions).toContain("compact facts, sources");
    expect(instructions).toContain("let that agent render the visuals once");
    expect(instructions).toContain("do not duplicate components");
  });

  it("explains quantities with honest scales and TeX without prohibiting reference tables", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain(
      "Neither Markdown nor t3-ui tables should replace a useful chart by default",
    );
    expect(instructions).toContain(
      "Keep different units on separate charts or clearly separate scales",
    );
    expect(instructions).toContain("never imply a shared numeric scale for unlike quantities");
    expect(instructions).toContain("explicit table requests and tabular reference or lookup tasks");
    expect(instructions).toContain(
      "a request to explain or compare quantities is not by itself a lookup task",
    );
    expect(instructions).toContain("$...$ inline, or $$ on separate lines");
    expect(instructions).toContain("Do not put equations in text code blocks");
    expect(instructions).toContain("Email drafts, simple facts and tasks without a useful visual");
    expect(instructions).toContain("Internal agent-to-agent handoffs and steering messages");
  });

  it("includes the bounded output policy independently of model metadata", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    const policy =
      instructions.match(/<tool_output_selection>[\s\S]*?<\/tool_output_selection>/)?.[0] ?? "";

    expect(policy).not.toBe("");
    expect(policy).toContain("Select before text()/notify()");
    expect(policy).toContain("Use small, already bounded tools directly");
    expect(policy).toContain("A read must use the same run's capture");
    expect(policy).toContain("task-local files have no guaranteed retention after cleanup");
    expect(buildRuntimeInstructions({ harness: "Claude Code", model: "default" })).toContain(
      policy,
    );
  });

  it("requires explicit registration of every PR and stack layer", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toContain("When the t3-code MCP server exposes link_pull_request");
    expect(instructions).toContain("with the full PR URL immediately after creating a PR");
    expect(instructions).toContain("For a stack, call it for every layer");
    expect(instructions).toContain("call list_thread_pull_requests and link any PR");
  });

  it("keeps known model and effort metadata on one line", () => {
    expect(
      buildRuntimeInstructions({
        harness: "Codex",
        model: "  custom\nmodel  ",
        reasoningEffort: " high\n",
      }),
    ).toContain("through the Codex harness, as custom model with high reasoning effort.");
  });

  it("names the model by display name and slug when they differ", () => {
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" }),
    ).toContain("through the Codex harness, as GPT-5.4 (model slug: gpt-5.4).");
    expect(
      buildRuntimeInstructions({ harness: "Codex", model: "my-model", modelName: "my-model" }),
    ).toContain("through the Codex harness, as my-model.");
  });

  it.each([undefined, "", "auto", "default"])("omits unresolved model %s", (model) => {
    const instructions = buildRuntimeInstructions({ harness: "Cursor", model });
    expect(instructions).toContain("through the Cursor harness.");
    expect(instructions).not.toContain("reasoning effort");
  });
});

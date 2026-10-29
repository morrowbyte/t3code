import * as NodeAssert from "node:assert/strict";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { describe, it } from "vite-plus/test";
import { parseStreamableUi } from "@t3tools/shared/streamableUi";

import {
  buildCodexAdditionalContext,
  CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexAdditionalContext", () => {
  describe.each([
    { model: "custom-model", modelName: "Custom 🦊 Model", reasoningEffort: "xhigh" },
    { model: "custom-model", modelName: "狐".repeat(1_500), reasoningEffort: "high" },
  ])("with runtime $model", (runtime) => {
    it.each([undefined, { browser: true, device: true }])(
      "keeps every entry within Codex's per-entry cap with tools %j",
      (availability) => {
        const context = buildCodexAdditionalContext(runtime, availability);
        for (const [key, entry] of Object.entries(context)) {
          const bytes = Buffer.byteLength(entry.value, "utf8");
          NodeAssert.ok(
            bytes <= CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,
            key + ": " + bytes + " bytes exceeds Codex's per-entry cap",
          );
        }
      },
    );
  });
  it("delivers all orchestration sections in authored order when keys are sorted", () => {
    const context = buildCodexAdditionalContext({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });
    const sections = Object.keys(context)
      .filter((key) => key.startsWith("t3_code_orchestration_"))
      .sort()
      .map((key) => context[key]!);
    NodeAssert.equal(
      sections.map((entry) => entry.value).join(""),
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    );
  });
});

describe("Codex runtime context", () => {
  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images, video, and audio.*Markdown image syntax with absolute file paths.*Link any other file.*absolute path.*files viewer.*<\/runtime_info>/,
      );
    }
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = runtimeInstructions({
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("T3 browser developer instructions", () => {
  const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };

  it("prefers the product-native preview tools", () => {
    {
      const instructions = toolInstructions(runtime, true);
      NodeAssert.match(instructions, /T3 Code browser/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Switch browsers only if the tools are absent/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    {
      const instructions = toolInstructions(runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code browser/);
      NodeAssert.doesNotMatch(instructions, /Switch browsers only if the tools are absent/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    NodeAssert.match(toolInstructions(runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(toolInstructions(runtime, false), /preview_open/);
  });
});

describe("Codex application context limits", () => {
  it("delivers complete visual examples within each entry's truncation budget", () => {
    const context = buildCodexAdditionalContext({ model: "gpt-6.1-sol", reasoningEffort: "low" });
    for (const entry of Object.values(context)) {
      NodeAssert.equal(entry.kind, "application");
      NodeAssert.ok(entry.value.length <= 2000);
    }
    const orchestration = contextText(context, "t3_code_orchestration");
    NodeAssert.equal(orchestration, T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    const examples = orchestration.split("\n").filter((line) => line.startsWith('{"type":'));
    for (const example of examples) {
      NodeAssert.ok(Object.values(context).some((entry) => entry.value.includes(example)));
    }
    const parsed = parseStreamableUi(examples.join("\n"), false);
    NodeAssert.equal(parsed.error, undefined);
    NodeAssert.deepEqual(
      parsed.components.map((component) => component.type),
      ["metric", "table", "chart", "chart", "cards", "timeline", "workflow", "report", "uml"],
    );
    const comparison = parsed.components.find((component) => component.id === "comparison");
    NodeAssert.equal(comparison?.type, "chart");
    if (comparison?.type !== "chart") return;
    NodeAssert.equal(comparison.series.length, 2);
    NodeAssert.equal(comparison.points.length, 2);
  });
});

function contextText(context: ReturnType<typeof buildCodexAdditionalContext>, prefix: string) {
  return Object.entries(context)
    .filter(([key]) => key === prefix || key.startsWith(`${prefix}_`))
    .map(([, entry]) => entry.value)
    .join("");
}

describe("Codex device context", () => {
  it("adds the shared device block only when the session holds device access", () => {
    const tools = (device: boolean) =>
      contextText(
        buildCodexAdditionalContext({ model: "gpt-6.1-sol" }, { browser: true, device }),
        "t3_code_tools",
      );

    NodeAssert.ok(tools(true).includes(T3_CODE_DEVICE_TOOL_INSTRUCTIONS));
    NodeAssert.ok(!tools(true).includes("ToolSearch"));
    NodeAssert.ok(!tools(false).includes("## T3 Code devices"));
  });
});

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return contextText(buildCodexAdditionalContext(runtime), "t3_code_runtime");
}
function toolInstructions(
  runtime: Parameters<typeof buildCodexAdditionalContext>[0],
  available: boolean,
) {
  return contextText(buildCodexAdditionalContext(runtime, available), "t3_code_tools");
}

import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { parseStreamableUi } from "@t3tools/shared/streamableUi";

import {
  buildCodexAdditionalContext,
  buildCodexDeveloperInstructions,
} from "./CodexDeveloperInstructions.ts";

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.match(
      buildCodexDeveloperInstructions("default"),
      /^<collaboration_mode># Collaboration Mode: Default/,
    );
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    {
      const instructions = runtimeInstructions({
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.match(buildCodexDeveloperInstructions("plan"), /^<collaboration_mode># Plan Mode/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = runtimeInstructions({
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = runtimeInstructions({
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
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

  it("prefers the product-native preview tools in both collaboration modes", () => {
    {
      const instructions = toolInstructions(runtime, true);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
  });

  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = toolInstructions(runtime, false);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<collaboration_mode>/);
      NodeAssert.match(buildCodexDeveloperInstructions(mode), /<\/collaboration_mode>/);
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

function runtimeInstructions(runtime: Parameters<typeof buildCodexAdditionalContext>[0]) {
  return contextText(buildCodexAdditionalContext(runtime), "t3_code_runtime");
}
function toolInstructions(
  runtime: Parameters<typeof buildCodexAdditionalContext>[0],
  available: boolean,
) {
  return contextText(buildCodexAdditionalContext(runtime, available), "t3_code_tools");
}

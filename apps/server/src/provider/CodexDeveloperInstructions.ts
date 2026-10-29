import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";

// Codex silently removes the middle of entries over 1,000 UTF-8-byte/4 tokens.
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  const instructions = [
    { key: "t3_code_orchestration", value: T3_CODE_ORCHESTRATION_INSTRUCTIONS },
    {
      key: "t3_code_runtime",
      value: buildRuntimeInstructions({
        harness: "Codex",
        ...runtime,
        visualProtocolAttached: true,
      }),
    },
    ...(tools ? [{ key: "t3_code_tools", value: tools }] : []),
  ];
  return Object.fromEntries(
    instructions.flatMap(({ key, value }) =>
      contextChunks(value).map((chunk, index) => [
        index === 0 && key !== "t3_code_orchestration"
          ? key
          : `${key}_${String(index + 1).padStart(2, "0")}`,
        { kind: "application", value: chunk },
      ]),
    ),
  );
}

function contextChunks(value: string): string[] {
  // Codex truncates application entries individually, including the middle of
  // JSONL examples. Leave room for punctuation-heavy protocol text and wrappers.
  const maxChars = 2000;
  const chunks: string[] = [];
  while (
    value.length > maxChars ||
    Buffer.byteLength(value, "utf8") > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES
  ) {
    let limit = Math.min(maxChars, value.length);
    while (
      Buffer.byteLength(value.slice(0, limit), "utf8") > CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES
    ) {
      limit -= 1;
    }
    if (/[\uD800-\uDBFF]/.test(value[limit - 1]!)) limit -= 1;
    const prefix = value.slice(0, limit);
    const newline = prefix.lastIndexOf("\n");
    const boundary = newline > 0 ? newline : prefix.lastIndexOf(" ");
    const end = boundary > 0 ? boundary + 1 : limit;
    chunks.push(value.slice(0, end));
    value = value.slice(end);
  }
  if (value) chunks.push(value);
  return chunks;
}

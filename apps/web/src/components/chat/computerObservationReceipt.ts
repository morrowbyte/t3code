import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type NativeToolItem = Pick<
  Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>,
  "toolName" | "status" | "output" | "outputOmitted"
>;

export function isNativeObservationTool(name: string | null): boolean {
  return (
    name !== null &&
    /^(?:mcp__weasel_desktop__|weasel_desktop[./])?desktop_(?:status|set_observation_mode)$/.test(
      name,
    )
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nativeReceipt(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === "string") {
    if (value.length > 16_384) return null;
    try {
      return nativeReceipt(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    const block = record(value[0]);
    return block?.type === "text" ? nativeReceipt(block.text, depth + 1) : null;
  }
  const data = record(value);
  if (!data || ("isError" in data && data.isError !== false) || data.error != null) return null;
  if (data.schema === 1) return data;
  if ("structuredContent" in data) {
    const structured = nativeReceipt(data.structuredContent, depth + 1);
    if ("content" in data) {
      const content = nativeReceipt(data.content, depth + 1);
      const fields = [
        "observation_mode",
        "observation_active",
        "observation_generation",
        "session_id",
        "epoch",
        "status",
      ];
      if (!structured || !content || fields.some((key) => structured[key] !== content[key]))
        return null;
    }
    return structured;
  }
  return nativeReceipt(data.content, depth + 1);
}

export function computerObservationReceipt(item: NativeToolItem) {
  if (!isNativeObservationTool(item.toolName)) return null;
  if (["failed", "cancelled", "interrupted"].includes(item.status))
    return { kind: "unconfirmed", reason: "failed" } as const;
  if (item.status !== "completed") return { kind: "unconfirmed", reason: "pending" } as const;
  if (item.outputOmitted || item.output === undefined)
    return { kind: "unconfirmed", reason: "unavailable" } as const;
  const data = nativeReceipt(item.output);
  if (
    !data ||
    (data.observation_mode !== "enabled" && data.observation_mode !== "disabled") ||
    typeof data.observation_active !== "boolean" ||
    typeof data.observation_generation !== "number" ||
    !Number.isSafeInteger(data.observation_generation) ||
    data.observation_generation < 0 ||
    (data.observation_mode === "disabled" && data.observation_active) ||
    (item.toolName?.endsWith("desktop_set_observation_mode") &&
      data.status !== "observation_mode_set")
  )
    return { kind: "unconfirmed", reason: "invalid" } as const;
  return {
    kind: "confirmed",
    mode: data.observation_mode,
    active: data.observation_active,
  } as const;
}

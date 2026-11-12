import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

type ComputerTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
const active = new Set(["pending", "running", "waiting"]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nativeOperation(name: string | null): string | undefined {
  return name?.match(
    /^(?:mcp__weasel_desktop__|weasel_desktop[./])?desktop_(act|observe|semantic|semantic_direct|windows|status|set_observation_mode)$/u,
  )?.[1];
}

export function isNativeInputTool(name: string | null): boolean {
  return nativeOperation(name) === "act";
}

function receipt(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;
  if (typeof value === "string") {
    if (value.length > 128_000) return null;
    try {
      return receipt(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    if (value.length > 32) return null;
    const blocks = value.map(record);
    if (blocks.some((block) => block?.type !== "text" && block?.type !== "image")) return null;
    const text = blocks.filter((block) => block?.type === "text");
    return text.length === 1 ? receipt(text[0]?.text, depth + 1) : null;
  }
  const data = record(value);
  if (!data || ("isError" in data && data.isError !== false)) return null;
  if (data.schema === 1) return data;
  if ("structuredContent" in data) {
    const structured = receipt(data.structuredContent, depth + 1);
    if ("content" in data) {
      const content = receipt(data.content, depth + 1);
      if (
        !structured ||
        !content ||
        [
          "schema",
          "task_id",
          "observation_id",
          "actor_release_confirmed",
          "background_semantic",
          "status",
        ].some((field) => structured[field] !== content[field])
      )
        return null;
    }
    return structured;
  }
  return receipt(data.content, depth + 1);
}

export function computerInputReceiptLabel(item: ComputerTool): string | null {
  if (!isNativeInputTool(item.toolName) || active.has(item.status)) return null;
  const input = record(item.input);
  const data = item.outputOmitted ? null : receipt(item.output);
  if (
    !data ||
    typeof input?.task_id !== "string" ||
    input.task_id.length === 0 ||
    typeof input.observation_id !== "string" ||
    input.observation_id.length === 0 ||
    data.task_id !== input.task_id ||
    data.observation_id !== input.observation_id ||
    data.actor_release_confirmed !== true
  )
    return "Input release unconfirmed";
  return data.background_semantic === true
    ? "Background action · input released at this call"
    : "Input released at this call";
}

export function computerInputTarget(item: ComputerTool): string | null {
  if (!isNativeInputTool(item.toolName)) return null;
  const actions = record(item.input)?.actions;
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const action = record(actions[0]);
  if (action?.kind === "launch_app")
    return action.app === "chrome" ? "Chrome" : action.app === "zed" ? "Zed" : null;
  if (action?.kind === "editor_open_project" || action?.kind === "editor_open_file") return "Zed";
  return action?.kind === "focus" &&
    typeof action.window_id === "number" &&
    Number.isSafeInteger(action.window_id) &&
    action.window_id > 0
    ? `Window ${action.window_id}`
    : null;
}

export function computerInputState(item: ComputerTool) {
  const operation = nativeOperation(item.toolName);
  const label = computerInputReceiptLabel(item);
  if (label !== null)
    return {
      kind:
        label === "Input release unconfirmed" ? ("unconfirmed" as const) : ("released" as const),
      label,
      target: null,
    };
  if (
    operation &&
    ["observe", "semantic_direct", "windows", "status", "set_observation_mode"].includes(
      operation,
    ) &&
    active.has(item.status)
  )
    return { kind: "read-only" as const, label: "No desktop input requested", target: null };
  const actions = record(item.input)?.actions;
  if (
    operation === "act" &&
    active.has(item.status) &&
    Array.isArray(actions) &&
    actions.some((value) =>
      [
        "launch_app",
        "editor_open_project",
        "editor_open_file",
        "focus",
        "semantic_focus",
        "close_window",
        "move",
        "click",
        "scroll",
        "drag",
        "type",
        "paste",
        "key",
      ].includes(String(record(value)?.kind)),
    )
  )
    return {
      kind: "foreground-requested" as const,
      label: "Foreground requested · pause keyboard and mouse",
      target: computerInputTarget(item),
    };
  return { kind: "unconfirmed" as const, label: "Input state unconfirmed", target: null };
}

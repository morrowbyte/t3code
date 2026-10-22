import { t3ToolResultIndicatesFailure } from "@t3tools/client-runtime/t3ToolSummary";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";

type MessageStatus = "info" | "fertig" | "blockiert" | "frage" | "entscheidung";
type SectionKind = "result" | "open" | "next" | "decision" | "technical" | "detail";
type Delivery = "started" | "queued" | "steered" | "restarted";

export function agentMessagePreview(text: string): string {
  return text.trim().split(/\r?\n[\t ]*\r?\n/u, 1)[0] ?? "";
}

interface MessageSection {
  readonly kind: SectionKind;
  readonly label: string;
  readonly text: string;
}

interface AgentMessagePresentation {
  readonly kind: "structured" | "legacy";
  readonly summary: string | null;
  readonly status: MessageStatus | null;
  readonly sections: ReadonlyArray<MessageSection>;
}

const SECTION_KINDS = new Map<string, SectionKind>([
  ["ergebnis", "result"],
  ["geprüft", "result"],
  ["offen", "open"],
  ["nächster schritt", "next"],
  ["entscheidung", "decision"],
  ["technik", "technical"],
  ["details", "detail"],
]);

function messageHeading(line: string) {
  const heading = /^ {0,3}##[\t ]+([^\r\n]+)$/u.exec(line);
  if (heading) {
    const title = heading[1]!.replace(/[\t ]+#+[\t ]*$/u, "").trim();
    if (title === "") return null;
    const colon = title.indexOf(":");
    const label = (colon < 0 ? title : title.slice(0, colon)).trim();
    if (label === "") return null;
    return {
      label,
      text: colon < 0 ? "" : title.slice(colon + 1).trimStart(),
    };
  }
  const strong = /^ {0,3}\*\*([^*\r\n]+)\*\*(:)?[\t ]*(.*)$/u.exec(line);
  if (strong) {
    const label = strong[1]!.trim();
    if (!label.endsWith(":") && !strong[2] && strong[3]) return null;
    const title = label.replace(/:$/u, "").trim();
    return title === "" ? null : { label: title, text: strong[3]! };
  }
  const plain = /^ {0,3}([\p{L}][\p{L}\p{N} _/-]{0,79}):[\t ]*(.*)$/u.exec(line);
  return plain ? { label: plain[1]!.trim(), text: plain[2]! } : null;
}

function messageStatus(text: string): MessageStatus | null {
  const status = text.toLowerCase();
  switch (status) {
    case "info":
    case "fertig":
    case "blockiert":
    case "frage":
    case "entscheidung":
      return status;
    default:
      return null;
  }
}

export function parseAgentMessage(text: string): AgentMessagePresentation {
  const legacy = { kind: "legacy", summary: null, status: null, sections: [] } as const;
  const lines = text.split(/\r?\n/u);
  const first = lines.findIndex((line) => line.trim() !== "");
  const opening = first < 0 ? null : messageHeading(lines[first]!);
  if (!opening || !["kurz", "summary"].includes(opening.label.toLowerCase())) return legacy;

  const blocks = [{ label: opening.label, lines: [opening.text] }];
  let current = blocks[0]!;
  let fence: { marker: string; length: number } | null = null;
  for (const line of lines.slice(first + 1)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (delimiter) {
      const marker = delimiter[1]!;
      if (fence === null) fence = { marker: marker[0]!, length: marker.length };
      else if (
        marker[0] === fence.marker &&
        marker.length >= fence.length &&
        delimiter[2]!.trim() === ""
      ) {
        fence = null;
      }
      current.lines.push(line);
      continue;
    }
    const candidate = fence === null ? messageHeading(line) : null;
    // Technical prose often contains label: value lines. Only known fields or
    // explicit Markdown headings end that disclosure.
    const heading =
      candidate &&
      current.label.toLowerCase() === "technik" &&
      !SECTION_KINDS.has(candidate.label.toLowerCase()) &&
      !["kurz", "summary", "status"].includes(candidate.label.toLowerCase()) &&
      !/^ {0,3}(?:##[\t ]|\*\*)/u.test(line)
        ? null
        : candidate;
    if (heading) {
      current = { label: heading.label, lines: [heading.text] };
      blocks.push(current);
    } else {
      current.lines.push(line);
    }
  }

  const summary = blocks[0]!.lines.join("\n").trim();
  if (summary === "") return legacy;
  const remaining = blocks.slice(1).map((block) => ({
    label: block.label,
    text: block.lines.join("\n").trim(),
  }));
  const statusBlocks = remaining.filter((block) => block.label.toLowerCase() === "status");
  const status = statusBlocks.length === 1 ? messageStatus(statusBlocks[0]!.text) : null;
  const sections = remaining.flatMap((block): MessageSection[] => {
    if (block === statusBlocks[0] && status !== null) return [];
    const kind = SECTION_KINDS.get(block.label.toLowerCase()) ?? "detail";
    return [{ kind, label: block.label, text: block.text || `${block.label}:` }];
  });
  return { kind: "structured", summary, status, sections };
}

const MAX_ENVELOPE_BYTES = 256 * 1024;
const MAX_ENVELOPE_DEPTH = 6;
const MAX_ENVELOPE_NODES = 128;
const MAX_CONTENT_BLOCKS = 32;

interface EnvelopeBudget {
  bytes: number;
  nodes: number;
}

interface Envelope {
  readonly data: Record<string, unknown> | null;
  readonly failed: boolean;
  readonly truncated: boolean;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readEnvelope(value: unknown, budget: EnvelopeBudget, depth = 0): Envelope {
  const empty = { data: null, failed: false, truncated: false };
  if (depth > MAX_ENVELOPE_DEPTH || budget.nodes-- <= 0) return { ...empty, truncated: true };
  if (typeof value === "string") {
    if (value.length > budget.bytes) return { ...empty, truncated: true };
    budget.bytes -= new TextEncoder().encode(value).byteLength;
    if (budget.bytes < 0) return { ...empty, truncated: true };
    try {
      return readEnvelope(JSON.parse(value), budget, depth + 1);
    } catch {
      return { ...empty, truncated: value.endsWith("\n… output truncated for transport") };
    }
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTENT_BLOCKS) return { ...empty, truncated: true };
    let result: Envelope = empty;
    for (const block of value) {
      const content = record(block);
      const text = content?.text ?? record(content?.content)?.text;
      const parsed = readEnvelope(record(text)?.text ?? text, budget, depth + 1);
      result = {
        data: result.data ?? parsed.data,
        failed: result.failed || parsed.failed,
        truncated: result.truncated || parsed.truncated,
      };
    }
    return result;
  }
  const data = record(value);
  if (!data) return empty;
  const failed = t3ToolResultIndicatesFailure({
    isError: data.isError,
    is_error: data.is_error,
    _tag: data._tag,
    error: data.error,
  });
  const content = data.structuredContent ?? data.content;
  if (content !== undefined) {
    const nested = readEnvelope(content, budget, depth + 1);
    return { ...nested, failed: failed || nested.failed };
  }
  return { data, failed, truncated: false };
}

function readToolValue(value: unknown) {
  return readEnvelope(value, { bytes: MAX_ENVELOPE_BYTES, nodes: MAX_ENVELOPE_NODES });
}

function identifier(value: unknown) {
  return typeof value === "string" && value.trim() !== "" && value === value.trim() ? value : null;
}

function deliveryMode(value: unknown): Delivery | null {
  switch (value) {
    case "started":
    case "queued":
    case "steered":
    case "restarted":
      return value;
    default:
      return null;
  }
}

export function readAgentSend(item: Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>): {
  targetThreadId: string | null;
  text: string | null;
  delivery: Delivery | null;
  accepted: boolean;
  failed: boolean;
  truncated: boolean;
} {
  const unknown = {
    targetThreadId: null,
    text: null,
    delivery: null,
    accepted: false,
    failed: false,
    truncated: false,
  };
  if (resolveT3McpToolId(item.toolName) !== "t3_thread_send") return unknown;

  let input = readToolValue(item.input);
  if (input.data && typeof input.data.toolName === "string" && "args" in input.data) {
    input = readToolValue(input.data.args);
  }
  const output = readToolValue(item.output);
  const summarized = input.data?.truncated === true && typeof input.data.summary === "string";
  const inputTarget = identifier(input.data?.threadId);
  const outputTarget = identifier(output.data?.threadId);
  const mismatch = inputTarget !== null && outputTarget !== null && inputTarget !== outputTarget;
  const failed =
    ["failed", "cancelled", "interrupted", "rolled_back"].includes(item.status) ||
    output.failed ||
    mismatch;
  const accepted =
    !failed &&
    !output.truncated &&
    outputTarget !== null &&
    identifier(output.data?.messageId) !== null;
  return {
    targetThreadId: inputTarget ?? outputTarget,
    text: !summarized && typeof input.data?.message === "string" ? input.data.message : null,
    delivery: accepted ? deliveryMode(output.data?.delivery) : null,
    accepted,
    failed,
    truncated: summarized || input.truncated || output.truncated,
  };
}

export function agentMessageParts(text: string): { lead: string; body: string } {
  // Display-only breaks must not reinterpret authored Markdown or alter raw/copy text.
  if (/[\r\n]|[`#*]|\[[^\]]*\]\(/.test(text)) {
    return { lead: text.split(/\r?\n/, 1)[0] ?? text, body: text };
  }
  const sentences: string[] = [];
  let pending = "";
  let germanQuoteOpen = false;
  // Hermes has no Intl sentence segmentation; retain authored bytes with a display-only split.
  const segments = text.match(/[\s\S]*?[.!?…](?:["'»”’“)]*)(?:\s+|$)|[\s\S]+$/gu) ?? [text];
  for (const part of segments) {
    pending += part;
    for (const character of part) {
      if (character === "„") germanQuoteOpen = true;
      else if (character === "“") germanQuoteOpen = false;
    }
    if (!germanQuoteOpen) {
      sentences.push(pending);
      pending = "";
    }
  }
  if (pending) sentences.push(pending);
  return { lead: sentences[0] ?? text, body: sentences.slice(1).join("\n\n") };
}

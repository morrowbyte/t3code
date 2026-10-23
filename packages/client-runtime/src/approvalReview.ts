import { hashTelemetryId as sha256Utf8 } from "@t3tools/shared/telemetryId";
import { ApprovalReviewOriginalOrder, type ApprovalReviewAuthority } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface ReviewSource {
  readonly path: string;
  readonly line: number;
  readonly endLine?: number;
}

export interface ReviewFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly language?: string;
  readonly presentation?: {
    readonly artifact: string;
    readonly role: "original" | "revised";
  };
}

export interface ReviewStep {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly source?: ReviewSource;
  readonly kind?: "start" | "step" | "decision" | "fork" | "join" | "end";
  readonly effects?: readonly string[];
}

export interface ReviewEdge {
  readonly from: string;
  readonly to: string;
  readonly label?: string;
}

export interface ReviewSymbol extends ReviewSource {
  readonly name: string;
}

export interface ReviewBundle {
  readonly schemaVersion: 1;
  readonly title: string;
  readonly packageId: string;
  readonly version: string;
  readonly hash: string;
  readonly files: readonly ReviewFile[];
  readonly steps: readonly ReviewStep[];
  readonly edges: readonly ReviewEdge[];
  readonly symbols: readonly ReviewSymbol[];
  readonly target: {
    readonly label: string;
    readonly identity?: string;
    readonly rights?: readonly string[];
  };
  readonly warnings: readonly string[];
  readonly exampleOnly: boolean;
  readonly originalOrder?: ApprovalReviewOriginalOrder;
  readonly agentRationale?: string;
}

export type ApprovalReviewDetail =
  | { readonly kind: "none" }
  | { readonly kind: "invalid"; readonly error: string }
  | { readonly kind: "bundle"; readonly bundle: ReviewBundle };

export type ReviewBundleVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly error: string };

const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_LENGTH = 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const STEP_KINDS = new Set(["start", "step", "decision", "fork", "join", "end"]);

function fail(message: string): never {
  throw new Error(message);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail(`${label} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) fail(`${label} contains an unknown field`);
    if (
      !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
      !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value")
    ) {
      fail(`${label} must contain plain data`);
    }
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum = 2000, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    fail(
      `${label} must be ${allowEmpty ? "a" : "a nonempty"} string of at most ${maximum} characters`,
    );
  }
  // Lone surrogates have no exact UTF-8 representation; reject instead of hashing replacement bytes.
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} contains invalid Unicode`);
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail(`${label} contains invalid Unicode`);
  }
  return value;
}

function array(value: unknown, label: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    fail(`${label} exceeds its array limit (${maximum})`);
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) fail(`${label} must not be sparse`);
  }
  return value;
}

function strings(value: unknown, label: string, maximum = 32): readonly string[] {
  return array(value, label, maximum).map((entry) => text(entry, label));
}

function path(value: unknown): string {
  const result = text(value, "File path", 240);
  if (
    /[\\:%?#]/u.test(result) ||
    Array.from(result).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    result.startsWith("/") ||
    result.split("/").some((part) => !part || part === "." || part === ".." || part.trim() !== part)
  ) {
    fail("File paths must be safe relative paths");
  }
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(`${label} must be a lowercase SHA-256 digest`);
  return result;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 128);
  if (!ID.test(result)) fail(`${label} must be a bounded identifier`);
  return result;
}

function source(value: unknown, files: ReadonlyMap<string, number>, symbol = false): ReviewSource {
  const item = record(
    value,
    "Source",
    symbol ? ["name", "path", "line", "endLine"] : ["path", "line", "endLine"],
  );
  const filePath = path(item.path);
  const lineCount = files.get(filePath);
  if (lineCount === undefined) fail(`Source file is missing: ${filePath}`);
  if (
    !Number.isSafeInteger(item.line) ||
    typeof item.line !== "number" ||
    item.line < 1 ||
    item.line > lineCount
  ) {
    fail(`Source line is outside ${filePath}`);
  }
  if (
    item.endLine !== undefined &&
    (!Number.isSafeInteger(item.endLine) ||
      typeof item.endLine !== "number" ||
      item.endLine < item.line ||
      item.endLine > lineCount)
  )
    fail(`Source endLine is outside ${filePath}`);
  return {
    path: filePath,
    line: item.line,
    ...(item.endLine === undefined ? {} : { endLine: item.endLine as number }),
  };
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}

function parseOriginalOrder(value: unknown): ApprovalReviewOriginalOrder {
  const order = Schema.decodeUnknownSync(ApprovalReviewOriginalOrder)(value, {
    onExcessProperty: "error",
  });
  const fullText = text(order.receipt.fullText, "Original order", 65_536);
  text(order.excerpt.text, "Original excerpt", 65_536);
  if (sha256Utf8(fullText) !== order.receipt.fullTextHash) fail("Original order SHA-256 mismatch");
  if (
    order.excerpt.endUtf16 <= order.excerpt.startUtf16 ||
    order.excerpt.endUtf16 > fullText.length ||
    fullText.slice(order.excerpt.startUtf16, order.excerpt.endUtf16) !== order.excerpt.text
  )
    fail("Original excerpt does not match the immutable order");
  const originalLink =
    order.receipt.version === 2
      ? `host-order:${order.receipt.orderId}`
      : `t3-thread://v1/${order.receipt.threadId}`;
  if (order.receipt.originalLink !== originalLink)
    fail("Original order reference does not match its source");
  return {
    receipt:
      order.receipt.version === 1
        ? {
            ...order.receipt,
            revision: { ...order.receipt.revision },
            lineage: { ...order.receipt.lineage },
          }
        : { ...order.receipt, assignment: { ...order.receipt.assignment } },
    excerpt: { ...order.excerpt },
    destination: { ...order.destination },
  };
}

function validateBundle(value: unknown): ReviewBundle {
  const item = record(value, "Review bundle", [
    "schemaVersion",
    "title",
    "packageId",
    "version",
    "hash",
    "files",
    "steps",
    "edges",
    "symbols",
    "target",
    "warnings",
    "exampleOnly",
    "originalOrder",
    "agentRationale",
  ]);
  if (item.schemaVersion !== 1) fail("Unsupported review schema version");
  if (typeof item.exampleOnly !== "boolean") fail("exampleOnly must be a boolean");
  let totalContent = 0;
  const lineCounts = new Map<string, number>();
  const presentations = new Set<string>();
  const files = array(item.files, "Files", 64).map((entry): ReviewFile => {
    const file = record(entry, "File", ["path", "content", "sha256", "language", "presentation"]);
    const filePath = path(file.path);
    if (lineCounts.has(filePath)) fail(`Duplicate file path: ${filePath}`);
    const content = text(file.content, "File content", MAX_CONTENT_LENGTH, true);
    totalContent += content.length;
    if (totalContent > MAX_CONTENT_LENGTH) fail("Review file contents exceed the total limit");
    lineCounts.set(
      filePath,
      content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
    );
    let presentation: ReviewFile["presentation"];
    if (file.presentation !== undefined) {
      const metadata = record(file.presentation, "Presentation", ["artifact", "role"]);
      const artifact = id(metadata.artifact, "Artifact");
      if (metadata.role !== "original" && metadata.role !== "revised")
        fail("Invalid presentation role");
      const key = `${artifact}:${metadata.role}`;
      if (presentations.has(key)) fail("Duplicate artifact presentation role");
      presentations.add(key);
      presentation = { artifact, role: metadata.role };
    }
    return {
      path: filePath,
      content,
      sha256: digest(file.sha256, "File hash"),
      ...(file.language === undefined ? {} : { language: text(file.language, "Language", 64) }),
      ...(presentation === undefined ? {} : { presentation }),
    };
  });
  if (files.length === 0) fail("A review bundle needs files");
  const stepIds = new Set<string>();
  const steps = array(item.steps, "Steps", 256).map((entry): ReviewStep => {
    const step = record(entry, "Step", ["id", "title", "description", "source", "kind", "effects"]);
    const stepId = id(step.id, "Step ID");
    if (stepIds.has(stepId)) fail(`Duplicate step ID: ${stepId}`);
    stepIds.add(stepId);
    if (step.kind !== undefined && (typeof step.kind !== "string" || !STEP_KINDS.has(step.kind)))
      fail("Invalid step kind");
    return {
      id: stepId,
      title: text(step.title, "Step title", 200),
      description: text(step.description, "Step description", 4000, true),
      ...(step.source === undefined ? {} : { source: source(step.source, lineCounts) }),
      ...(step.kind === undefined ? {} : { kind: step.kind as NonNullable<ReviewStep["kind"]> }),
      ...(step.effects === undefined ? {} : { effects: strings(step.effects, "Effects") }),
    };
  });
  const edgeIds = new Set<string>();
  const edges = array(item.edges, "Edges", 1024).map((entry): ReviewEdge => {
    const edge = record(entry, "Edge", ["from", "to", "label"]);
    const from = id(edge.from, "Edge source");
    const to = id(edge.to, "Edge destination");
    if (!stepIds.has(from) || !stepIds.has(to)) fail("Edge refers to an unknown step");
    const label = edge.label === undefined ? undefined : text(edge.label, "Edge label", 200);
    const key = JSON.stringify([from, to, label]);
    if (edgeIds.has(key)) fail("Duplicate edge");
    edgeIds.add(key);
    return { from, to, ...(label === undefined ? {} : { label }) };
  });
  const symbolIds = new Set<string>();
  const symbols = array(item.symbols, "Symbols", 2048).map((entry): ReviewSymbol => {
    const location = source(entry, lineCounts, true);
    const name = text((entry as Record<string, unknown>).name, "Symbol name", 200);
    const key = JSON.stringify([name, location.path, location.line]);
    if (symbolIds.has(key)) fail("Duplicate symbol");
    symbolIds.add(key);
    return { name, ...location };
  });
  const target = record(item.target, "Target", ["label", "identity", "rights"]);
  const bundle: ReviewBundle = {
    schemaVersion: 1,
    title: text(item.title, "Title", 200),
    packageId: id(item.packageId, "Package ID"),
    version: text(item.version, "Version", 128),
    hash: digest(item.hash, "Package hash"),
    files,
    steps,
    edges,
    symbols,
    target: {
      label: text(target.label, "Target label", 200),
      ...(target.identity === undefined
        ? {}
        : { identity: text(target.identity, "Target identity", 512) }),
      ...(target.rights === undefined ? {} : { rights: strings(target.rights, "Target rights") }),
    },
    warnings: strings(item.warnings, "Warnings", 64),
    exampleOnly: item.exampleOnly,
    ...(item.originalOrder === undefined
      ? {}
      : { originalOrder: parseOriginalOrder(item.originalOrder) }),
    ...(item.agentRationale === undefined
      ? {}
      : { agentRationale: text(item.agentRationale, "Agent rationale", 65_536, true) }),
  };
  if (new TextEncoder().encode(JSON.stringify(bundle)).length > MAX_PAYLOAD_BYTES)
    fail("Review payload exceeds 2 MiB");
  return freeze(bundle);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid approval review";
}

export function parseApprovalReviewDetail(detail: unknown): ApprovalReviewDetail {
  let value = detail;
  if (typeof detail === "string") {
    if (detail.length > MAX_PAYLOAD_BYTES) {
      return /["']?approvalReview["']?\s*:/u.test(detail)
        ? { kind: "invalid", error: "Review payload exceeds 2 MiB" }
        : { kind: "none" };
    }
    try {
      value = JSON.parse(detail);
    } catch {
      return /["']?approvalReview["']?\s*:/u.test(detail)
        ? { kind: "invalid", error: "Malformed approvalReview JSON envelope" }
        : { kind: "none" };
    }
  }
  if (typeof value !== "object" || value === null || !("approvalReview" in value))
    return { kind: "none" };
  try {
    const envelope = record(value, "Approval review envelope", ["approvalReview"]);
    return { kind: "bundle", bundle: validateBundle(envelope.approvalReview) };
  } catch (error) {
    return { kind: "invalid", error: errorMessage(error) };
  }
}

export function isStructuredApprovalReviewDetail(detail: unknown): boolean {
  return parseApprovalReviewDetail(detail).kind !== "none";
}

// Even matching bytes are not authority: the backend must bind requestId + hash before acceptance exists.
export function reviewBundleAllowsAcceptance(_bundle: ReviewBundle): false {
  return false;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const item = value as Record<string, unknown>;
    return `{${Object.keys(item)
      .filter((key) => item[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Package SHA-256: UTF-8 JSON, recursively sorted object keys, array order preserved,
// no whitespace or Unicode/newline normalization; omit only the top-level hash field.
export function canonicalReviewBundleSnapshot(bundle: Omit<ReviewBundle, "hash">): string {
  return canonical(Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== "hash")));
}

// The server verifies the host order and paired channel. This binds its decision
// to the exact immutable original shown by the client, without fetching a chat DB.
export function reviewBundleHasVerifiedOrderChannel(
  bundle: ReviewBundle,
  authority: ApprovalReviewAuthority | undefined,
): boolean {
  if (
    !authority?.originalOrder ||
    authority.provenance?.status !== "verified" ||
    !bundle.originalOrder ||
    authority.packageHash !== bundle.hash ||
    authority.verifiedTargetId !== bundle.target.identity ||
    authority.agentRationale !== bundle.agentRationale
  )
    return false;
  try {
    const order = parseOriginalOrder(bundle.originalOrder);
    const receipt = order.receipt;
    if (
      receipt.version !== 2 ||
      receipt.forwardRevision !== 1 ||
      receipt.assignment.orderId !== receipt.orderId ||
      receipt.assignment.orderRevision !== receipt.orderRevision ||
      receipt.assignment.fullTextHash !== receipt.fullTextHash ||
      receipt.assignment.threadId !== order.destination.threadId ||
      receipt.assignment.runId !== order.destination.runId ||
      receipt.assignment.environmentId === receipt.sourceEnvironmentId
    )
      return false;
    return (
      canonical(order) === canonical(authority.originalOrder) &&
      sha256Utf8(canonicalReviewBundleSnapshot(bundle)) === bundle.hash
    );
  } catch {
    return false;
  }
}

export function reviewBundleHasVerifiedOriginalOrder(
  bundle: ReviewBundle,
  authority: ApprovalReviewAuthority | undefined,
): boolean {
  const receipt = bundle.originalOrder?.receipt;
  return (
    !bundle.exampleOnly &&
    receipt?.version === 2 &&
    receipt.sourceKind === "human" &&
    !receipt.testOnly &&
    reviewBundleHasVerifiedOrderChannel(bundle, authority)
  );
}

export async function verifyReviewBundle(bundle: ReviewBundle): Promise<ReviewBundleVerification> {
  try {
    const snapshot = validateBundle(bundle);
    for (const file of snapshot.files) {
      if (sha256Utf8(file.content) !== file.sha256)
        return { valid: false, error: `File SHA-256 mismatch: ${file.path}` };
    }
    if (sha256Utf8(canonicalReviewBundleSnapshot(snapshot)) !== snapshot.hash) {
      return { valid: false, error: "Package SHA-256 mismatch" };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, error: errorMessage(error) };
  }
}

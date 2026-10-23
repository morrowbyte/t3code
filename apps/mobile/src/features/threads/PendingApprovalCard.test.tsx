import {
  AuthSessionId,
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ApprovalReviewAuthority,
  type ApprovalReviewOriginalOrder,
} from "@t3tools/contracts";
import {
  canonicalReviewBundleSnapshot,
  type ReviewBundle,
} from "@t3tools/client-runtime/approvalReview";
import * as NodeCrypto from "node:crypto";
import { act, type ReactNode, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
const harness = vi.hoisted(() => ({
  presses: new Map<string, () => void>(),
  navigate: vi.fn(),
  copy: vi.fn(async (_text: string) => true),
  threadShell: vi.fn((_ref: unknown) => undefined),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: harness.navigate }),
}));
vi.mock("../../state/entities", () => ({ useThreadShell: harness.threadShell }));
vi.mock("../agent-identity/AgentIdentityLabel", () => ({
  AgentIdentityLabel: () => <span>Existing agent identity</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: harness.copy }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Modal: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
    ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Pressable: ({
      children,
      onPress,
      disabled,
      accessibilityLabel,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      accessibilityLabel?: string;
    }) => {
      const label =
        React.isValidElement<{ children?: ReactNode }>(children) &&
        typeof children.props.children === "string"
          ? children.props.children
          : "details";
      if (onPress) harness.presses.set(accessibilityLabel ?? label, onPress);
      return (
        <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
          {children}
        </button>
      );
    },
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => {
    harness.presses.set(label, onPress);
    return (
      <button onClick={onPress} disabled={disabled}>
        {label}
      </button>
    );
  },
}));
import { PendingApprovalCard } from "./PendingApprovalCard";
let root: Root | undefined;
let host: HTMLDivElement;
const requestId = RuntimeRequestId.make("mobile-approval");
const approval = {
  requestId,
  requestKind: "command" as const,
  createdAt: "2026-10-15T00:00:00.000Z",
  responseCapability: "live" as const,
  detail: "pwsh -Command {\n  Write-Output '脚本'\n}\n" + "# original\n".repeat(100),
  options: [
    { decision: "accept" as const, label: "Provider allows once" },
    { decision: "decline" as const, label: "Deny" },
    { decision: "cancel" as const, label: "Cancel request" },
  ],
};
const reviewFixture: ReviewBundle = {
  schemaVersion: 1,
  title: "Review fixture",
  packageId: "native-test-fixture",
  version: "1",
  hash: "0".repeat(64),
  files: [
    {
      path: "fixture.ps1",
      content: Array.from({ length: 110 }, (_, index) => `# fixture line ${index + 1}`).join("\n"),
      sha256: "0".repeat(64),
      language: "powershell",
    },
  ],
  steps: [
    {
      id: "inspect",
      title: "Inspect fixture source",
      description: "Test fixture only; never executed.",
      source: { path: "fixture.ps1", line: 105 },
      kind: "step",
    },
  ],
  edges: [],
  symbols: [{ name: "FixtureSymbol", path: "fixture.ps1", line: 105 }],
  target: { label: "Fixture target", rights: ["fixture right"] },
  warnings: ["Not execution evidence"],
  exampleOnly: false,
};
function reviewApproval(bundle: ReviewBundle = reviewFixture) {
  return { ...approval, detail: JSON.stringify({ approvalReview: bundle }) };
}
const sha256 = (value: string) =>
  NodeCrypto.createHash("sha256").update(value, "utf8").digest("hex");
function hostApproval(receiptLifetime = 60_000) {
  // Unit-test metadata models a human Host V2 order; no real host channel or VM run is established.
  const fullText =
    " \r\nKurz: exact order 🦦, not an agent summary\nTechnik:\n  Keep this immutable.\n";
  const excerptText = "Technik:\n  Keep this immutable.";
  const originalOrder = {
    receipt: {
      version: 2,
      orderId: "native-test-order",
      orderRevision: 1,
      forwardRevision: 1,
      sourceKind: "human",
      testOnly: false,
      sourceEnvironmentId: EnvironmentId.make("synthetic-source-env"),
      sessionId: AuthSessionId.make("synthetic-human-session"),
      principal: "synthetic-human-principal",
      threadId: ThreadId.make("synthetic-source-thread"),
      messageId: MessageId.make("native-test-registry-record"),
      createdAt: Date.now() - 1_000,
      expiresAt: Date.now() + receiptLifetime,
      fullText,
      fullTextHash: sha256(fullText),
      originalLink: "host-order:native-test-order",
      assignment: {
        instructionHash: sha256("Native unit-test forwarded instruction; never executed"),
        orderId: "native-test-order",
        orderRevision: 1,
        commandId: "native-test-forward-command",
        fullTextHash: sha256(fullText),
        environmentId: EnvironmentId.make("native-test-vm-env"),
        threadId: ThreadId.make("native-test-vm-thread"),
        messageId: MessageId.make("native-test-forward-message"),
        runId: RunId.make("native-test-vm-run"),
        runOrdinal: 7,
        acceptedSequence: 42,
      },
    },
    excerpt: {
      startUtf16: fullText.indexOf(excerptText),
      endUtf16: fullText.indexOf(excerptText) + excerptText.length,
      text: excerptText,
    },
    destination: {
      threadId: ThreadId.make("native-test-vm-thread"),
      runId: RunId.make("native-test-vm-run"),
    },
  } satisfies ApprovalReviewOriginalOrder;
  const snapshot = {
    ...reviewFixture,
    originalOrder,
    agentRationale: "Synthetic agent rationale; separate from the original human order.",
    files: reviewFixture.files.map((file) => ({ ...file, sha256: sha256(file.content) })),
    target: { ...reviewFixture.target, identity: "fixture-host" },
  };
  const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
  const authority = {
    packageHash: bundle.hash,
    verifiedTargetId: "fixture-host",
    expiresAt: Date.now() + 60_000,
    state: "pending",
    approverSessionId: AuthSessionId.make("fixture-approver-session"),
    approverSubject: "fixture-approver",
    requesterSubject: "fixture-requester",
    workerSubject: "fixture-worker",
    action: {
      kind: "create_file_once",
      verifiedTargetId: "fixture-host",
      path: "fixture.txt",
      content: "never executed",
      mode: 384,
      expectedAbsent: true,
      implementationVersion: "fixture-v1",
      implementationHash: "a".repeat(64),
    },
    implementationSource: "fixture only",
    originalOrder,
    agentRationale: snapshot.agentRationale,
    provenance: { status: "verified", reason: "trusted-original" },
  } satisfies ApprovalReviewAuthority;
  return {
    ...reviewApproval(bundle),
    approvalReview: authority,
    responseCapability: "external" as const,
  };
}
function withOriginalOrder(
  pending: ReturnType<typeof hostApproval>,
  originalOrder: ApprovalReviewOriginalOrder,
) {
  const { approvalReview: originalBundle } = JSON.parse(pending.detail) as {
    approvalReview: ReviewBundle;
  };
  const snapshot = { ...originalBundle, originalOrder };
  const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
  return {
    ...pending,
    detail: JSON.stringify({ approvalReview: bundle }),
    approvalReview: { ...pending.approvalReview, originalOrder, packageHash: bundle.hash },
  };
}
const respond = vi.fn(
  async (_id: RuntimeRequestId, _decision: string, _hash?: string) => undefined,
);
type Props = ComponentProps<typeof PendingApprovalCard>;
function render(overrides: Partial<Props> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() =>
    root!.render(
      <PendingApprovalCard
        approval={approval}
        environmentId={EnvironmentId.make("env-a")}
        environmentLabel="RemoteHost"
        runtimeMode="auto"
        canOperateThread
        respondingApprovalId={null}
        onRespond={respond}
        {...overrides}
      />,
    ),
  );
}
function button(label: string, scope: ParentNode = host) {
  const result = [...scope.querySelectorAll("button")].find((item) => item.textContent === label);
  expect(result).toBeDefined();
  return result!;
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  harness.presses.clear();
  harness.navigate.mockReset();
  harness.copy.mockClear();
  harness.threadShell.mockClear();
  respond.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("PendingApprovalCard", () => {
  it("shows the real peer, configured mode and exact expandable code without inferring sudo rights", () => {
    render();
    expect(host.textContent).toContain("RemoteHost");
    expect(host.textContent).toContain("Auto");
    expect(host.textContent).not.toContain(approval.detail);
    act(() => button("Show provider details").click());
    expect(host.textContent).toContain(approval.detail);
    expect(host.textContent).toContain("OS privilege: Not supplied");
    expect(host.textContent).toContain("Effective provider policy: Not supplied");
    expect(host.textContent).toContain("Execution unconfirmed");
  });
  it("preserves provider-supported reject/cancel choices and fallback warnings", async () => {
    render({
      approval: {
        ...approval,
        options: [
          {
            decision: "accept",
            label: "Allow once only",
            warning: "Provider cannot grant the requested session scope.",
          },
          { decision: "cancel", label: "Stop this request" },
        ],
      },
    });
    expect(host.textContent).toContain("Provider cannot grant the requested session scope.");
    expect(host.textContent).not.toContain("Allow session");
    await act(async () => button("Stop this request").click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel");
  });
  it("refuses stale/nonresumable or permission-revoked callbacks", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    render({ approval: { ...approval, responseCapability: "not_resumable" } });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Provider disconnected");
    render({ canOperateThread: false });
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("does not retarget an old callback or old detail disclosure after switching peers", async () => {
    render();
    const stale = harness.presses.get("Provider allows once")!;
    act(() => button("Show provider details").click());
    render({ environmentId: EnvironmentId.make("env-b"), environmentLabel: "NodeX37" });
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("NodeX37");
    expect(host.textContent).not.toContain("RemoteHost");
    expect(host.textContent).not.toContain(approval.detail);
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("submits only once while a decision is in flight", async () => {
    let complete!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    render({ onRespond: pending });
    const press = harness.presses.get("Provider allows once")!;
    act(() => {
      press();
      press();
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  it("keeps a failed response retryable without presenting a completed action", async () => {
    respond.mockRejectedValueOnce(new Error("private error"));
    render();
    await act(async () => button("Provider allows once").click());
    expect(host.textContent).toContain("No decision was confirmed");
    expect(host.textContent).not.toContain("private error");
    await act(async () => button("Provider allows once").click());
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it("opens exact fallback details fullscreen and keeps existing response authority", async () => {
    render();
    act(() => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain(approval.detail);
    expect(dialog.textContent).not.toContain("Package integrity verified");
    act(() => button("Steps").click());
    expect(dialog.textContent).toContain("No step graph supplied.");
    await act(async () => harness.presses.get("Deny")!());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
    act(() => button("Close review").click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("blocks every accepting callback for bundles while preserving real decline/cancel", async () => {
    render({ approval: reviewApproval() });
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    expect(host.textContent).toContain("cannot bind a decision");
    await act(async () => harness.presses.get("Cancel request")!());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel");
    render({ approval: { ...reviewApproval(), options: undefined } });
    expect(button("Allow once").disabled).toBe(true);
    expect(button("Allow session").disabled).toBe(true);
    await act(async () => harness.presses.get("Allow session")!());
    expect(respond).toHaveBeenCalledTimes(1);
    await act(async () => button("Decline").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("never calls the response channel for examples and fails closed for invalid bundles", async () => {
    render({ approval: reviewApproval({ ...reviewFixture, exampleOnly: true }) });
    for (const label of ["Provider allows once", "Deny", "Cancel request"]) {
      expect(button(label).disabled).toBe(true);
      await act(async () => harness.presses.get(label)!());
    }
    expect(respond).not.toHaveBeenCalled();
    render({ approval: { ...approval, detail: JSON.stringify({ approvalReview: {} }) } });
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline");
  });
  it("opens supplied step and symbol references without inventing edges or verification", async () => {
    const pending = reviewApproval();
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("# fixture line 1");
    expect(dialog.textContent).not.toContain("# fixture line 105");
    expect(dialog.textContent).not.toContain("Package integrity verified");
    expect(dialog.textContent).toContain("File SHA-256 mismatch: fixture.ps1");
    act(() => button("Steps").click());
    expect(dialog.textContent).toContain("Inspect fixture source");
    expect(dialog.textContent).not.toContain("Connections");
    act(() => button("fixture.ps1:105").click());
    expect(dialog.textContent).toContain("Lines 101–110 of 110");
    expect(dialog.textContent).toContain("# fixture line 105");
    act(() => button("Previous lines").click());
    act(() => button("FixtureSymbol · fixture.ps1:105").click());
    expect(dialog.textContent).toContain("Selected line 105");
    act(() => button("Show original request").click());
    expect(dialog.textContent).toContain(pending.detail);
  });
  it("closes review and refuses captured decisions when request text or destination changes", async () => {
    render();
    act(() => button("Open Approval Review").click());
    const stale = harness.presses.get("Provider allows once")!;
    render({ approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Open Approval Review").click());
    render({ environmentId: EnvironmentId.make("env-b"), approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    render({ approval: reviewApproval() });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });
  it("approves only the verified fullscreen host package and keeps raw or closed callbacks blocked", async () => {
    const pending = hostApproval();
    render({ approval: pending });
    expect(host.textContent).toContain("Review external action");
    expect(host.textContent).not.toContain("Provider disconnected");
    const rawAccept = harness.presses.get("Provider allows once")!;
    expect(button("Provider allows once").disabled).toBe(true);
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Package integrity verified");
    expect(dialog.textContent).toContain("Verified target: fixture-host");
    expect(button("Provider allows once").disabled).toBe(true);
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => rawAccept());
    expect(respond).not.toHaveBeenCalled();
    const reviewedAccept = harness.presses.get("Provider allows once")!;
    await act(async () => button("Provider allows once", dialog).click());
    expect(respond).toHaveBeenCalledWith(requestId, "accept", pending.approvalReview.packageHash);
    act(() => button("Close review").click());
    await act(async () => reviewedAccept());
    expect(respond).toHaveBeenCalledTimes(1);
  });
  it("expands and copies the Host V2 registry order without suggesting or navigating to a timeline origin", async () => {
    const pending = hostApproval();
    const order = pending.approvalReview.originalOrder!;
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Host order and request channel verified");
    expect(dialog.textContent).toContain(`Principal: ${order.receipt.principal}`);
    expect(dialog.textContent).toContain(order.excerpt.text);
    expect(dialog.textContent).not.toContain(order.receipt.fullText);
    expect(dialog.textContent).toContain("Agent rationale");
    expect(dialog.textContent).toContain(pending.approvalReview.agentRationale);
    act(() => harness.presses.get("Expand human order")!());
    expect(dialog.textContent).toContain(order.receipt.fullText);
    for (const value of [
      order.receipt.sourceEnvironmentId,
      order.receipt.threadId,
      order.receipt.messageId,
      order.receipt.orderId,
      order.receipt.fullTextHash,
      order.receipt.assignment.runId,
      order.destination.runId,
      order.receipt.assignment.environmentId,
      order.receipt.assignment.commandId,
      order.receipt.assignment.instructionHash,
      order.receipt.originalLink,
    ])
      expect(dialog.textContent).toContain(value);
    expect(dialog.textContent).toContain("Order revision: 1");
    expect(dialog.textContent).toContain("Forward revision: 1");
    expect(dialog.textContent).toContain("Run ordinal: 7");
    expect(dialog.textContent).toContain("Accepted sequence: 42");
    expect(dialog.textContent).not.toContain("Issuer:");
    expect(button("Original", dialog)).toBeDefined();
    await act(async () => button("Copy original", dialog).click());
    expect(harness.copy).toHaveBeenCalledWith(order.receipt.fullText);
    expect(harness.threadShell).toHaveBeenCalledWith(null);
    expect(harness.threadShell.mock.calls.every((args) => args[0] === null)).toBe(true);
    expect(dialog.textContent).toContain(`Registry record: ${order.receipt.messageId}`);
    expect(dialog.textContent).toContain(`Context thread: ${order.receipt.threadId}`);
    expect(dialog.textContent).not.toContain("Original thread");
    expect(harness.presses.has("Open original thread")).toBe(false);
    const context = [...dialog.querySelectorAll("span")].find((item) =>
      item.textContent?.startsWith("Context thread:"),
    );
    expect(context).toBeDefined();
    act(() => context!.click());
    expect(harness.navigate).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(respond).not.toHaveBeenCalled();
  });
  it.each(["missing", "trust-unconfigured", "unsupported-lineage", "legacy"] as const)(
    "blocks acceptance for %s originals while retaining decline and cancel",
    async (reason) => {
      const pending = hostApproval();
      const unverified: ApprovalReviewAuthority =
        reason === "missing"
          ? {
              ...pending.approvalReview,
              originalOrder: undefined,
              provenance: { status: "unverified", reason: "missing-original" },
            }
          : reason === "legacy"
            ? { ...pending.approvalReview, provenance: undefined }
            : { ...pending.approvalReview, provenance: { status: "unverified", reason } };
      render({ approval: { ...pending, approvalReview: unverified } });
      await act(async () => button("Open Approval Review").click());
      const dialog = host.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Package integrity verified");
      expect(dialog.textContent).toContain("Original order unverified");
      expect(dialog.textContent).not.toContain("Host order and request channel verified");
      expect(dialog.textContent).not.toContain("Principal:");
      expect(harness.presses.has("Expand human order")).toBe(false);
      expect(button("Provider allows once", dialog).disabled).toBe(true);
      await act(async () => harness.presses.get("Provider allows once")!());
      expect(respond).not.toHaveBeenCalled();
      await act(async () => button("Deny", dialog).click());
      expect(respond).toHaveBeenCalledWith(
        requestId,
        "decline",
        pending.approvalReview.packageHash,
      );
      await act(async () => button("Cancel request", dialog).click());
      expect(respond).toHaveBeenCalledWith(requestId, "cancel", pending.approvalReview.packageHash);
    },
  );
  it.each(["principal", "order", "assignment", "instruction", "destination", "selection"] as const)(
    "rejects a self-consistent package with a %s different from backend source authority",
    async (field) => {
      const pending = hostApproval();
      const order = pending.approvalReview.originalOrder!;
      const changedOrder: ApprovalReviewOriginalOrder = {
        ...order,
        receipt: {
          ...order.receipt,
          ...(field === "principal" ? { principal: "different-principal" } : {}),
          ...(field === "order"
            ? {
                orderId: "different-order",
                originalLink: "host-order:different-order",
                assignment: { ...order.receipt.assignment, orderId: "different-order" },
              }
            : {}),
          ...(field === "assignment"
            ? { assignment: { ...order.receipt.assignment, commandId: "different-command" } }
            : {}),
          ...(field === "instruction"
            ? {
                assignment: {
                  ...order.receipt.assignment,
                  instructionHash: sha256("Different forwarded instruction"),
                },
              }
            : {}),
          ...(field === "destination"
            ? { assignment: { ...order.receipt.assignment, runId: RunId.make("different-run") } }
            : {}),
        },
        ...(field === "destination"
          ? { destination: { ...order.destination, runId: RunId.make("different-run") } }
          : {}),
        ...(field === "selection"
          ? { excerpt: { startUtf16: 0, endUtf16: 12, text: order.receipt.fullText.slice(0, 12) } }
          : {}),
      };
      const { approvalReview: originalBundle } = JSON.parse(pending.detail) as {
        approvalReview: ReviewBundle;
      };
      const snapshot = { ...originalBundle, originalOrder: changedOrder };
      const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
      render({
        approval: {
          ...pending,
          detail: JSON.stringify({ approvalReview: bundle }),
          approvalReview: { ...pending.approvalReview, packageHash: bundle.hash },
        },
      });
      await act(async () => button("Open Approval Review").click());
      const dialog = host.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Package integrity verified");
      expect(dialog.textContent).toContain("Original order unverified");
      expect(dialog.textContent).not.toContain("Principal:");
      expect(harness.presses.has("Expand human order")).toBe(false);
      act(() => button("Show original request", dialog).click());
      expect(dialog.textContent).toContain(JSON.stringify({ approvalReview: bundle }));
      expect(button("Provider allows once", dialog).disabled).toBe(true);
      await act(async () => harness.presses.get("Provider allows once")!());
      expect(respond).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["synthetic", true],
    ["synthetic", false],
    ["human", true],
  ] as const)(
    "labels the verified %s/testOnly=%s channel as a test and never accepts it",
    async (sourceKind, testOnly) => {
      const pending = hostApproval();
      const order = pending.approvalReview.originalOrder;
      const testOrder = { ...order, receipt: { ...order.receipt, sourceKind, testOnly } };
      const testApproval = withOriginalOrder(pending, testOrder);
      render({ approval: testApproval });
      await act(async () => button("Open Approval Review").click());
      const dialog = host.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).toContain("Host order and request channel verified");
      expect(dialog.textContent).toContain("Synthetic test order · ACCEPT disabled");
      act(() => harness.presses.get("Expand synthetic test order")!());
      expect(dialog.textContent).toContain(order.receipt.fullText);
      expect(button("Provider allows once", dialog).disabled).toBe(true);
      await act(async () => harness.presses.get("Provider allows once")!());
      expect(respond).not.toHaveBeenCalled();
      await act(async () => button("Deny", dialog).click());
      expect(respond).toHaveBeenCalledWith(
        requestId,
        "decline",
        testApproval.approvalReview.packageHash,
      );
    },
  );
  it("keeps V1 legacy receipts unverified even with verified metadata and exposes only the raw source", async () => {
    const pending = hostApproval();
    const order = pending.approvalReview.originalOrder;
    const source = order.receipt;
    const legacyOrder: ApprovalReviewOriginalOrder = {
      ...order,
      receipt: {
        version: 1,
        issuerId: "legacy-test-issuer",
        keyId: "legacy-test-key",
        sourceHostId: "legacy-test-host",
        sourceEnvironmentId: source.sourceEnvironmentId,
        sessionId: source.sessionId,
        principal: source.principal,
        threadId: source.threadId,
        messageId: source.messageId,
        runId: source.assignment.runId,
        revision: { eventId: "legacy-test-event", sequence: 1, updatedAt: source.createdAt },
        capturedAt: source.createdAt,
        expiresAt: source.expiresAt,
        fullText: source.fullText,
        fullTextHash: source.fullTextHash,
        originalLink: `t3-thread://v1/${source.threadId}`,
        lineage: {
          rootThreadId: source.threadId,
          rootRunId: source.assignment.runId,
          delegation: "none",
        },
        signature: "A".repeat(86),
      },
    };
    const legacy = withOriginalOrder(pending, legacyOrder);
    render({ approval: legacy });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Package integrity verified");
    expect(dialog.textContent).toContain("Legacy original order · unverified");
    expect(dialog.textContent).not.toContain("Principal:");
    expect(harness.presses.has("Expand human order")).toBe(false);
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    act(() => button("Show original request", dialog).click());
    expect(dialog.textContent).toContain(legacy.detail);
    await act(async () => button("Cancel request", dialog).click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel", legacy.approvalReview.packageHash);
  });
  it("withholds the origin card when file integrity fails despite exact host-order channel metadata", async () => {
    const pending = hostApproval();
    const { approvalReview: originalBundle } = JSON.parse(pending.detail) as {
      approvalReview: ReviewBundle;
    };
    const snapshot = {
      ...originalBundle,
      files: originalBundle.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
    };
    const bundle = { ...snapshot, hash: sha256(canonicalReviewBundleSnapshot(snapshot)) };
    render({
      approval: {
        ...pending,
        detail: JSON.stringify({ approvalReview: bundle }),
        approvalReview: { ...pending.approvalReview, packageHash: bundle.hash },
      },
    });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("File SHA-256 mismatch: fixture.ps1");
    expect(dialog.textContent).not.toContain("Host order and request channel verified");
    expect(dialog.textContent).not.toContain("Principal:");
    expect(harness.presses.has("Expand human order")).toBe(false);
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("rejects tampered full text and a stale accepting callback after backend provenance changes", async () => {
    const pending = hostApproval();
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const staleAccept = harness.presses.get("Provider allows once")!;
    const order = pending.approvalReview.originalOrder!;
    render({
      approval: {
        ...pending,
        approvalReview: {
          ...pending.approvalReview,
          originalOrder: {
            ...order,
            receipt: {
              ...order.receipt,
              assignment: { ...order.receipt.assignment, commandId: "different-command" },
            },
          },
        },
      },
    });
    await act(async () => staleAccept());
    expect(respond).not.toHaveBeenCalled();
    render({
      approval: {
        ...pending,
        approvalReview: {
          ...pending.approvalReview,
          provenance: { status: "unverified", reason: "untrusted-issuer" },
        },
      },
    });
    await act(async () => staleAccept());
    expect(respond).not.toHaveBeenCalled();
    const { approvalReview: bundle } = JSON.parse(pending.detail) as {
      approvalReview: ReviewBundle;
    };
    render({
      approval: {
        ...pending,
        detail: JSON.stringify({
          approvalReview: {
            ...bundle,
            originalOrder: {
              ...order,
              receipt: { ...order.receipt, fullText: "Agent replacement of human text" },
            },
          },
        }),
      },
    });
    await act(async () => button("Open Approval Review").click());
    expect(host.textContent).toContain("Original order SHA-256 mismatch");
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("rechecks expiry at submission and disables open review decisions when its timer expires", async () => {
    vi.useFakeTimers();
    const pending = hostApproval();
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const reviewedAccept = harness.presses.get("Provider allows once")!;
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    expect(dialog.textContent).toContain("no longer pending or has expired");
    await act(async () => reviewedAccept());
    expect(respond).not.toHaveBeenCalled();
  });
  it("expires the source receipt before the request and retains rejection until the request expires", async () => {
    vi.useFakeTimers();
    const pending = hostApproval(1_000);
    render({ approval: pending });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    const staleAccept = harness.presses.get("Provider allows once")!;
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    await act(async () => staleAccept());
    expect(respond).not.toHaveBeenCalled();
    expect(button("Deny", dialog).disabled).toBe(false);
    await act(async () => button("Deny", dialog).click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline", pending.approvalReview.packageHash);
    await act(async () => vi.advanceTimersByTime(59_000));
    expect(button("Deny", dialog).disabled).toBe(true);
    expect(button("Cancel request", dialog).disabled).toBe(true);
  });
  it("rejects changed authority, target mismatch, unverified hashes, examples and session scope", async () => {
    const pending = hostApproval();
    render({ approval: { ...pending, options: undefined } });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(button("Allow session", dialog).disabled).toBe(true);
    await act(async () => harness.presses.get("Allow session")!());
    const staleAccept = harness.presses.get("Allow once")!;
    render({
      approval: { ...pending, approvalReview: { ...pending.approvalReview, state: "claimed" } },
    });
    await act(async () => staleAccept());
    expect(respond).not.toHaveBeenCalled();
    render({
      approval: {
        ...pending,
        approvalReview: { ...pending.approvalReview, verifiedTargetId: "other-host" },
      },
    });
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    expect(button("Provider allows once", dialog).disabled).toBe(true);
    render({ approval: { ...pending, detail: reviewApproval().detail } });
    await act(async () => button("Open Approval Review").click());
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
    await act(async () => button("Close review").click());
    render({ approval: { ...pending, responseCapability: "live" } });
    await act(async () => button("Open Approval Review").click());
    await act(async () => harness.presses.get("Provider allows once")!());
    expect(respond).not.toHaveBeenCalled();
  });
  it("binds raw host rejection and cancellation to the current authority hash", async () => {
    const pending = hostApproval();
    render({ approval: pending });
    await act(async () => button("Deny").click());
    expect(respond).toHaveBeenCalledWith(requestId, "decline", pending.approvalReview.packageHash);
    await act(async () => button("Cancel request").click());
    expect(respond).toHaveBeenCalledWith(requestId, "cancel", pending.approvalReview.packageHash);
  });
  it("shows resolved server Failure without closing or claiming a confirmed host decision", async () => {
    const denied = vi.fn(async () => ({ _tag: "Failure" as const, cause: "private server cause" }));
    render({ approval: hostApproval(), onRespond: denied });
    await act(async () => button("Open Approval Review").click());
    const dialog = host.querySelector('[role="dialog"]')!;
    await act(async () => button("Provider allows once", dialog).click());
    expect(denied).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="dialog"]')).toBe(dialog);
    expect(dialog.textContent).toContain("No decision was confirmed");
    expect(dialog.textContent).not.toContain("private server cause");
    expect(dialog.textContent).not.toContain("Approval submitted");
    expect(button("Provider allows once", dialog).disabled).toBe(false);
    await act(async () => button("Provider allows once", dialog).click());
    expect(denied).toHaveBeenCalledTimes(2);
  });
});

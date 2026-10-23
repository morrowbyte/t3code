import {
  AuthSessionId,
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ApprovalReviewHostOrder,
  type ApprovalReviewOrderCreate,
  type ApprovalReviewOrderReadiness,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { EnvironmentRpcUnavailableError } from "@t3tools/client-runtime/rpc";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { approvalOrderEnvironment } from "../../state/approvalOrders";
import { useHostOrderComposerStore } from "./HostOrderComposerStore";
import { HostOrderComposer } from "./HostOrderComposer";

vi.mock("../../state/approvalOrders", async () => {
  const command = () => ({ label: "test-order", run: vi.fn(), permissionAtom: vi.fn() });
  return {
    approvalOrderEnvironment: {
      create: command(),
      read: command(),
      cancel: command(),
      readiness: command(),
    },
  };
});

const environmentId = EnvironmentId.make("isolated-host");
const hostThreadId = ThreadId.make("host-control-thread");
const destination: ScopedThreadRef = {
  environmentId: EnvironmentId.make("isolated-vm"),
  threadId: ThreadId.make("vm-thread"),
};
const ready: ApprovalReviewOrderReadiness = {
  enabled: true,
  reason: "ready",
  sourceKind: "synthetic",
  testOnly: true,
  channels: [
    {
      hostThreadId,
      vmId: "test-vm",
      label: "Isolated test VM",
      environmentId: EnvironmentId.make("isolated-vm"),
      threadId: ThreadId.make("vm-thread"),
      ready: true,
      reason: "ready",
    },
  ],
};

function makeOrder(input: ApprovalReviewOrderCreate): ApprovalReviewHostOrder {
  return {
    source: {
      version: 2,
      orderId: `order-${input.clientRequestId}`,
      orderRevision: 1,
      sourceKind: "synthetic",
      testOnly: true,
      sourceEnvironmentId: environmentId,
      sessionId: AuthSessionId.make("synthetic-session"),
      principal: "synthetic-subject",
      threadId: input.sourceThreadId,
      messageId: MessageId.make("host-message"),
      createdAt: input.expiresAt - 15 * 60_000,
      expiresAt: input.expiresAt,
      fullText: input.text,
      fullTextHash: "a".repeat(64),
      originalLink: `host-order:order-${input.clientRequestId}`,
    },
    vmId: input.vmId,
    targetThreadId: destination.threadId,
    state: "active",
    forwardRevision: 1,
    assignment: {
      instructionHash: "b".repeat(64),
      orderId: `order-${input.clientRequestId}`,
      orderRevision: 1,
      commandId: "test-command",
      fullTextHash: "a".repeat(64),
      environmentId: destination.environmentId,
      threadId: destination.threadId,
      messageId: MessageId.make("actual-vm-message"),
      runId: RunId.make("actual-vm-run"),
      runOrdinal: 1,
      acceptedSequence: 1,
    },
  };
}

function setup(readiness: ApprovalReviewOrderReadiness = ready) {
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  for (const command of Object.values(approvalOrderEnvironment)) {
    vi.mocked(command.run).mockReset();
    vi.mocked(command.permissionAtom).mockReset().mockReturnValue(Atom.make(true));
  }
  vi.mocked(approvalOrderEnvironment.readiness.run).mockResolvedValue(
    AsyncResult.success(readiness),
  );
  vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async (_registry, target) =>
    AsyncResult.success(makeOrder(target.input)),
  );
}

it("stays closed when ordinary connection permissions lack host source qualification", async () => {
  setup({ enabled: true, reason: "ready", channels: ready.channels });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(
      screen.getByText("The host has not confirmed a qualified human or synthetic test session."),
    )
    .toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "An exact task");
  await expect
    .element(screen.getByRole("button", { name: "Send task", exact: true }))
    .toBeDisabled();
  expect(approvalOrderEnvironment.create.run).not.toHaveBeenCalled();
});

it("shows the backend's blocked reason and no fabricated destinations", async () => {
  setup({ enabled: false, reason: "channel-unconfigured", channels: [] });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(screen.getByText("No authorized VM destination is configured."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Send task", exact: true }))
    .toBeDisabled();
  expect(screen.container.textContent).not.toContain("Isolated test VM");
});

it("allows the explicitly qualified human session without any provider selection", async () => {
  setup({
    ...ready,
    sourceKind: "human",
    testOnly: false,
    channels: [
      {
        ...ready.channels[0]!,
        vmId: "foreign-env",
        label: "Foreign environment",
        environmentId: EnvironmentId.make("other-vm"),
      },
      {
        ...ready.channels[0]!,
        vmId: "foreign-thread",
        label: "Foreign thread",
        threadId: ThreadId.make("other-thread"),
      },
      ...ready.channels,
    ],
  });
  vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async (_registry, target) => {
    const order = makeOrder(target.input);
    return AsyncResult.success({
      ...order,
      source: { ...order.source, sourceKind: "human", testOnly: false },
    });
  });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect.element(screen.getByText("VM: Isolated test VM")).toBeVisible();
  await expect.element(screen.getByText("Host: Protecting host", { exact: true })).toBeVisible();
  await expect.element(screen.getByText(environmentId, { exact: true })).not.toBeVisible();
  await screen.getByText("Connection details", { exact: true }).click();
  await expect.element(screen.getByText(environmentId, { exact: true })).toBeVisible();
  await expect.element(screen.getByText(destination.threadId, { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Foreign environment");
  expect(screen.container.textContent).not.toContain("Foreign thread");
  expect(screen.container.querySelector('[role="combobox"]')).toBeNull();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Human original");
  await userEvent.click(screen.getByRole("button", { name: "Send task", exact: true }));
  await expect.element(screen.getByText("Active", { exact: true })).toBeVisible();
  expect(screen.container.textContent).not.toContain("Synthetic test");
  expect(
    vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1].input.sourceThreadId,
  ).toBe(hostThreadId);
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1].environmentId).toBe(
    environmentId,
  );
  expect(hostThreadId).not.toBe(destination.threadId);
  expect(environmentId).not.toBe(destination.environmentId);
  expect(screen.container.querySelector("a")?.getAttribute("href")).toBe(
    `/${environmentId}/${hostThreadId}`,
  );
});

it("fails closed when host policy only binds another VM environment or thread", async () => {
  setup({
    ...ready,
    channels: [
      {
        ...ready.channels[0]!,
        environmentId: EnvironmentId.make("foreign-vm"),
        label: "Foreign VM",
      },
      { ...ready.channels[0]!, threadId: ThreadId.make("foreign-thread"), label: "Foreign thread" },
    ],
  });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(screen.getByText("This host has no authorized channel for the selected VM thread."))
    .toBeVisible();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Task" }),
    "Do not route to a foreign channel",
  );
  await expect.element(screen.getByRole("button", { name: "Send synthetic task" })).toBeDisabled();
  expect(screen.container.textContent).not.toContain("Foreign VM");
  expect(screen.container.textContent).not.toContain("Foreign thread");
  expect(approvalOrderEnvironment.create.run).not.toHaveBeenCalled();
  expect(approvalOrderEnvironment.readiness.run).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: {},
  });
});

it("rejects a matching VM channel when its required host control binding is missing", async () => {
  const malformedChannel = { ...ready.channels[0]! };
  Reflect.deleteProperty(malformedChannel, "hostThreadId");
  setup({ ...ready, channels: [malformedChannel] });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(screen.getByText("The host has not bound a control thread to this VM channel."))
    .toBeVisible();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Task" }),
    "Do not use the VM thread as source",
  );
  await expect.element(screen.getByRole("button", { name: "Send synthetic task" })).toBeDisabled();
  expect(approvalOrderEnvironment.create.run).not.toHaveBeenCalled();
});

it("sends the exact original once, labels synthetic source and reads/cancels only on request", async () => {
  setup();
  const onCreated = vi.fn();
  let finish!: (order: ApprovalReviewHostOrder) => void;
  const response = new Promise<ApprovalReviewHostOrder>((resolve) => {
    finish = resolve;
  });
  vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async () =>
    AsyncResult.success(await response),
  );
  await using screen = await render(
    <HostOrderComposer
      environmentId={environmentId}
      destination={destination}
      onCreated={onCreated}
    />,
  );
  await expect
    .element(screen.getByText("Synthetic test · cannot approve or claim actions"))
    .toBeVisible();
  const original = "  Original task\nKeep spacing and ünicode.  ";
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), original);
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  await expect.element(screen.getByRole("textbox", { name: "Task" })).toBeDisabled();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  const target = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1];
  expect(target).toMatchObject({
    environmentId,
    input: { sourceThreadId: hostThreadId, text: original, vmId: "test-vm" },
  });
  expect(target.input.clientRequestId).toBeTruthy();
  const order = makeOrder(target.input);
  await act(async () => finish(order));
  await expect.element(screen.getByText("Synthetic test · Active", { exact: true })).toBeVisible();
  expect(screen.container.textContent).toContain(`VM thread: ${destination.threadId}`);
  expect(screen.container.textContent).toContain("actual-vm-run");
  expect(onCreated).toHaveBeenCalledWith(order);
  expect(approvalOrderEnvironment.read.run).not.toHaveBeenCalled();
  expect(approvalOrderEnvironment.cancel.run).not.toHaveBeenCalled();
  vi.mocked(approvalOrderEnvironment.read.run).mockResolvedValue(AsyncResult.success(order));
  await userEvent.click(screen.getByRole("button", { name: "Read current order" }));
  expect(approvalOrderEnvironment.read.run).toHaveBeenCalledWith(expect.anything(), {
    environmentId,
    input: { orderId: order.source.orderId },
  });
  vi.mocked(approvalOrderEnvironment.cancel.run).mockResolvedValue(
    AsyncResult.success({
      ...order,
      state: "cancelled",
      alreadyClaimedActions: [
        {
          threadId: hostThreadId,
          requestId: RuntimeRequestId.make("already-claimed-test"),
          packageHash: "c".repeat(64),
          claimId: "committed-claim",
          state: "claimed",
          action: {
            kind: "create_file_once",
            verifiedTargetId: "fixture-target",
            path: "/never-created/already-claimed.txt",
            content: "fixture only",
            mode: 384,
            expectedAbsent: true,
            implementationVersion: "fixture-v1",
            implementationHash: "d".repeat(64),
          },
        },
      ],
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel order" }));
  await expect
    .element(screen.getByText("Synthetic test · Cancelled", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Cancel order" })).toBeDisabled();
  expect(screen.container.textContent).toContain("Previously claimed actions may still complete.");
  await userEvent.click(screen.getByText("Already claimed · cannot be recalled (1)"));
  await expect.element(screen.getByText("/never-created/already-claimed.txt")).toBeVisible();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
});

it("recovers a lost response only by explicit reuse of the identical send input", async () => {
  setup();
  vi.mocked(approvalOrderEnvironment.create.run).mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({
          environmentId,
          message: "Connection lost after send",
        }),
      ),
    ),
  );
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(screen.getByText("Synthetic test · cannot approve or claim actions"))
    .toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "  unchanged original  ");
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  await expect.element(screen.getByText("Connection lost after send")).toBeVisible();
  const first = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1];
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByRole("button", { name: "Send synthetic task" })).toBeDisabled();
  await userEvent.click(screen.getByRole("button", { name: "Retry same send" }));
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(2);
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[1]![1]).toEqual(first);
  await expect.element(screen.getByText("Synthetic test · Active", { exact: true })).toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "A different task");
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  const next = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[2]![1];
  expect(next.input.clientRequestId).not.toBe(first.input.clientRequestId);
  expect(next.input.text).toBe("A different task");
  expect(screen.container.querySelectorAll("section")).toHaveLength(2);
});

it("does not redirect an unknown send after the host control binding changes", async () => {
  setup();
  vi.mocked(approvalOrderEnvironment.create.run).mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({ environmentId, message: "Lost create response" }),
      ),
    ),
  );
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect.element(screen.getByText("VM: Isolated test VM")).toBeVisible();
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Task" }),
    "Keep the original channel binding",
  );
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  await expect.element(screen.getByRole("button", { name: "Retry same send" })).toBeEnabled();
  const original = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1].input;
  expect(original.sourceThreadId).toBe(hostThreadId);
  vi.mocked(approvalOrderEnvironment.readiness.run).mockResolvedValue(
    AsyncResult.success({
      ...ready,
      channels: [{ ...ready.channels[0]!, hostThreadId: ThreadId.make("changed-host-control") }],
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "Check readiness" }));
  await expect.element(screen.getByText("VM: Isolated test VM")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry same send" })).toBeDisabled();
  await expect
    .element(
      screen.getByText(
        "Original host channel binding is unavailable; this send cannot be retried.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send synthetic task" })).toBeDisabled();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
});

it("chooses only among policy channels for the exact destination and preserves unknown", async () => {
  setup({
    ...ready,
    channels: [
      ...ready.channels,
      { ...ready.channels[0]!, vmId: "second-vm", label: "Second isolated VM" },
      {
        ...ready.channels[0]!,
        vmId: "foreign-vm",
        environmentId: EnvironmentId.make("foreign-vm"),
        label: "Foreign VM",
      },
    ],
  });
  vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async (_registry, target) =>
    AsyncResult.success({
      ...makeOrder(target.input),
      state: "forward-unknown",
      assignment: null,
      forwardRevision: 0,
    }),
  );
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect.element(screen.getByText("Choose an authorized VM channel.")).toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Destination-specific task");
  await expect.element(screen.getByRole("button", { name: "Send synthetic task" })).toBeDisabled();
  await userEvent.click(screen.getByRole("combobox", { name: "VM channel" }));
  await expect.element(page.getByRole("option", { name: "Foreign VM" })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("option", { name: "Second isolated VM" }));
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1].input.vmId).toBe(
    "second-vm",
  );
  await expect
    .element(screen.getByText("Synthetic test · Forwarding outcome unknown", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("No VM receive acknowledgement.")).toBeVisible();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  expect(approvalOrderEnvironment.read.run).not.toHaveBeenCalled();
});

it("shows expired host state and an ambiguous cancel without claiming a stop", async () => {
  setup();
  vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async (_registry, target) => {
    const order = makeOrder(target.input);
    return AsyncResult.success({
      ...order,
      source: { ...order.source, expiresAt: 1 },
    });
  });
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(screen.getByText("Synthetic test · cannot approve or claim actions"))
    .toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Expiring task");
  await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
  await expect
    .element(
      screen.getByText("Synthetic test · Expired · last host state: Active", { exact: true }),
    )
    .toBeVisible();
  vi.mocked(approvalOrderEnvironment.cancel.run).mockResolvedValue(
    AsyncResult.failure(
      Cause.fail(new EnvironmentRpcUnavailableError({ environmentId, message: "Connection lost" })),
    ),
  );
  await userEvent.click(screen.getByRole("button", { name: "Cancel order" }));
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Cancellation outcome unknown: Connection lost");
  expect(screen.container.textContent).not.toContain("Cancelled");
});

it.each(["host", "vm-environment", "vm-thread"] as const)(
  "drops old state after changing %s and ignores the previous response",
  async (changed) => {
    setup();
    const onCreated = vi.fn();
    let finish!: (order: ApprovalReviewHostOrder) => void;
    const response = new Promise<ApprovalReviewHostOrder>((resolve) => {
      finish = resolve;
    });
    vi.mocked(approvalOrderEnvironment.create.run).mockImplementation(async () =>
      AsyncResult.success(await response),
    );
    await using screen = await render(
      <HostOrderComposer
        environmentId={environmentId}
        destination={destination}
        onCreated={onCreated}
      />,
    );
    await expect
      .element(screen.getByText("Synthetic test · cannot approve or claim actions"))
      .toBeVisible();
    await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Old host task");
    await userEvent.click(screen.getByRole("button", { name: "Send synthetic task" }));
    const oldInput = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1].input;
    await screen.rerender(
      <HostOrderComposer
        environmentId={changed === "host" ? EnvironmentId.make("new-host") : environmentId}
        destination={
          changed === "vm-environment"
            ? { ...destination, environmentId: EnvironmentId.make("new-vm") }
            : changed === "vm-thread"
              ? { ...destination, threadId: ThreadId.make("new-vm-thread") }
              : destination
        }
        onCreated={onCreated}
      />,
    );
    await act(async () => finish(makeOrder(oldInput)));
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.container.querySelectorAll("section")).toHaveLength(0);
    expect(screen.container.querySelector("textarea")?.value).toBe("");
  },
);

it("retains an unknown request across opt-out without sending or retrying until explicitly requested", async () => {
  setup();
  vi.mocked(approvalOrderEnvironment.create.run).mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(new EnvironmentRpcUnavailableError({ environmentId, message: "Response lost" })),
    ),
  );
  const content = (active: boolean) => (
    <HostOrderComposer environmentId={environmentId} destination={destination} active={active} />
  );
  await using screen = await render(content(false));
  expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
  await screen.rerender(content(true));
  await expect.element(screen.getByText("VM: Isolated test VM")).toBeVisible();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Exact retained task");
  await screen.getByRole("button", { name: "Send synthetic task" }).click();
  await expect.element(screen.getByText("Send outcome unknown", { exact: true })).toBeVisible();
  const original = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1];
  await screen.rerender(content(false));
  await expect.element(screen.getByRole("button", { name: "Retry same send" })).toBeDisabled();
  await expect
    .element(screen.getByRole("textbox", { name: "Task" }))
    .toHaveValue("Exact retained task");
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  await screen.rerender(content(true));
  await expect.element(screen.getByRole("button", { name: "Retry same send" })).toBeEnabled();
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  await screen.getByRole("button", { name: "Retry same send" }).click();
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[1]![1]).toEqual(original);
});

it("distinguishes an offline host without checking or creating an order", async () => {
  setup();
  await using screen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} connected={false} />,
  );
  await expect.element(screen.getByText("Protecting host is offline.")).toBeVisible();
  expect(approvalOrderEnvironment.readiness.run).not.toHaveBeenCalled();
  await userEvent.fill(screen.getByRole("textbox", { name: "Task" }), "Saved offline draft");
  await expect
    .element(screen.getByRole("button", { name: "Send task", exact: true }))
    .toBeDisabled();
  expect(approvalOrderEnvironment.create.run).not.toHaveBeenCalled();
});

it("hydrates an unknown request after reload without generating a new send identity", async () => {
  setup();
  vi.mocked(approvalOrderEnvironment.create.run).mockResolvedValueOnce(
    AsyncResult.failure(
      Cause.fail(
        new EnvironmentRpcUnavailableError({
          environmentId,
          message: "Lost response before reload",
        }),
      ),
    ),
  );
  await using originalScreen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect.element(originalScreen.getByText("VM: Isolated test VM")).toBeVisible();
  await userEvent.fill(
    originalScreen.getByRole("textbox", { name: "Task" }),
    "Reload keeps exact input",
  );
  await originalScreen.getByRole("button", { name: "Send synthetic task" }).click();
  await expect
    .element(originalScreen.getByText("Send outcome unknown", { exact: true }))
    .toBeVisible();
  const original = vi.mocked(approvalOrderEnvironment.create.run).mock.calls[0]![1];
  await originalScreen.unmount();
  const storageKey = "t3code:host-order-drafts:v1";
  const persisted = sessionStorage.getItem(storageKey)!;
  useHostOrderComposerStore.setState({ sessions: {}, selectedHosts: {} });
  sessionStorage.setItem(storageKey, persisted);
  await useHostOrderComposerStore.persist.rehydrate();
  await using restoredScreen = await render(
    <HostOrderComposer environmentId={environmentId} destination={destination} />,
  );
  await expect
    .element(restoredScreen.getByRole("button", { name: "Retry same send" }))
    .toBeEnabled();
  await expect
    .element(restoredScreen.getByRole("textbox", { name: "Task" }))
    .toHaveValue("Reload keeps exact input");
  expect(approvalOrderEnvironment.create.run).toHaveBeenCalledTimes(1);
  await restoredScreen.getByRole("button", { name: "Retry same send" }).click();
  expect(vi.mocked(approvalOrderEnvironment.create.run).mock.calls[1]![1]).toEqual(original);
});

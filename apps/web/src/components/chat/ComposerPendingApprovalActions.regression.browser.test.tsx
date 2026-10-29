import {
  EnvironmentId,
  ThreadId,
  RuntimeRequestId,
  type ProviderApprovalOption,
} from "@t3tools/contracts";
import { type ReactNode, type ReactElement } from "react";
import { act, render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../approvalReview/ApprovalReview", () => ({ ApprovalReview: () => null }));

const harness = vi.hoisted(() => ({ handlers: new Map<string, () => void>() }));
vi.mock("../ui/button", async () => {
  const React = await import("react");
  const text = (children: ReactNode): string =>
    React.Children.toArray(children)
      .map((child) =>
        typeof child === "string"
          ? child
          : React.isValidElement<{ children?: ReactNode }>(child)
            ? text(child.props.children)
            : "",
      )
      .join("");
  const Button = ({
    children,
    onClick,
    disabled,
    "aria-label": label,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => {
    if (onClick) harness.handlers.set(label ?? text(children), onClick);
    return (
      <button disabled={disabled} aria-label={label} onClick={onClick}>
        {children}
      </button>
    );
  };
  return { Button, InlineButton: Button };
});
vi.mock("../ui/menu", async () => {
  const React = await import("react");
  const Context = React.createContext({ open: false, toggle: () => {} });
  return {
    Menu: ({ children }: { children: ReactNode }) => {
      const [open, setOpen] = React.useState(false);
      return (
        <Context.Provider value={{ open, toggle: () => setOpen((value) => !value) }}>
          {children}
        </Context.Provider>
      );
    },
    MenuTrigger: ({
      render,
      children,
      disabled,
    }: {
      render: ReactElement<{ onClick?: () => void; disabled?: boolean; children?: ReactNode }>;
      children: ReactNode;
      disabled?: boolean;
    }) => {
      const context = React.useContext(Context);
      return React.cloneElement(render, {
        disabled: disabled === true,
        onClick: context.toggle,
        children,
      });
    },
    MenuPopup: ({ children }: { children: ReactNode }) =>
      React.useContext(Context).open ? <div role="menu">{children}</div> : null,
    MenuItem: ({
      children,
      disabled,
      onClick,
    }: {
      children: ReactNode;
      disabled?: boolean;
      onClick?: () => void;
    }) => (
      <button role="menuitem" disabled={disabled} onClick={onClick}>
        {children}
      </button>
    ),
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
const requestId = RuntimeRequestId.make("approval-response");
const options: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "decline", label: "Deny" },
  { decision: "cancel", label: "Cancel request" },
];
const respond = vi.fn(async (_id: RuntimeRequestId, _decision: string) => undefined);
type Props = React.ComponentProps<typeof ComposerPendingApprovalActions>;
function actions(overrides: Partial<Props> = {}) {
  return (
    <ComposerPendingApprovalActions
      requestId={requestId}
      canRespond
      isResponding={false}
      options={options}
      onRespondToApproval={respond}
      {...overrides}
    />
  );
}
function button(host: HTMLElement, label: string) {
  const found = [...host.querySelectorAll("button")].find(
    (item) => item.textContent === label || item.getAttribute("aria-label") === label,
  );
  expect(found).toBeDefined();
  return found!;
}
function testFixture(): Disposable {
  const previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  return {
    [Symbol.dispose]() {
      if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
      else Reflect.deleteProperty(window, "desktopBridge");
      harness.handlers.clear();
      respond.mockReset();
    },
  };
}

describe("ComposerPendingApprovalActions", () => {
  it("routes a privileged rejection through the desktop bridge with its exact target and hash", async () => {
    using _fixture = testFixture();

    const desktopRespond = vi.fn(async () => undefined);
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { respondToPrivilegedDecision: desktopRespond },
    });
    const environmentId = EnvironmentId.make("local-id");
    const threadId = ThreadId.make("thread-id");
    const packageHash = "a".repeat(64);
    const approval = {
      requestId,
      requestKind: "command",
      createdAt: "2026-10-27T00:00:00Z",
      responseCapability: "external",
      detail: "",
      privilegedCommand: { packageHash },
    } as unknown as NonNullable<Props["approval"]>;
    await using screen = await render(actions({ approval, environmentId, threadId }));
    await act(async () => button(screen.container, "Deny").click());
    expect(desktopRespond).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      threadId,
      requestId,
      decision: "decline",
      packageHash,
    });
    expect(respond).not.toHaveBeenCalled();
    Reflect.deleteProperty(window, "desktopBridge");
  });

  it("sends a privileged decision through the signed environment connection when the desktop route requires DPoP", async () => {
    using _fixture = testFixture();

    const error =
      "T3 Connect approval requires the renderer-bound DPoP signer; this route is not yet supported by the desktop approval transport.";
    const desktopRespond = vi.fn(async () => {
      throw new Error(`IPC: ${error}`);
    });
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      value: { respondToPrivilegedDecision: desktopRespond },
    });
    const approval = {
      requestId,
      requestKind: "command",
      createdAt: "2026-10-27T00:00:00Z",
      responseCapability: "external",
      detail: "",
      privilegedCommand: { packageHash: "a".repeat(64) },
    } as unknown as NonNullable<Props["approval"]>;
    await using screen = await render(
      actions({
        approval,
        environmentId: EnvironmentId.make("win"),
        threadId: ThreadId.make("thread"),
      }),
    );
    await act(async () => button(screen.container, "Deny").click());
    expect(respond).toHaveBeenCalledExactlyOnceWith(requestId, "decline", "a".repeat(64));
  });

  it("submits actual provider decisions, including reject and cancel", async () => {
    using _fixture = testFixture();

    await using screen = await render(actions());
    await act(async () => button(screen.container, "Deny").click());
    expect(respond).toHaveBeenLastCalledWith(requestId, "decline");
    await act(() => button(screen.container, "More approval options").click());
    await act(async () => button(screen.container, "Cancel request").click());
    expect(respond).toHaveBeenLastCalledWith(requestId, "cancel");
  });
  it("blocks every decision on nonresumable requests, including an already-open more menu", async () => {
    using _fixture = testFixture();

    await using screen = await render(actions());
    await act(() => button(screen.container, "More approval options").click());
    await screen.rerender(actions({ canRespond: false }));
    await act(async () => {
      button(screen.container, "Allow once").click();
      button(screen.container, "Deny").click();
      button(screen.container, "Cancel request").click();
    });
    expect(respond).not.toHaveBeenCalled();
  });
  it("coalesces repeated clicks before parent responding state reaches the component", async () => {
    using _fixture = testFixture();

    let complete!: () => void;
    const pending = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await using _screen = await render(actions({ onRespondToApproval: pending }));
    const click = harness.handlers.get("Allow once")!;
    await act(() => {
      click();
      click();
    });
    expect(pending).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  it("refuses stale callbacks after the request or destination-bound responder changes", async () => {
    using _fixture = testFixture();

    const first = vi.fn(async () => undefined);
    const next = vi.fn(async () => undefined);
    await using screen = await render(actions({ onRespondToApproval: first }));
    const stale = harness.handlers.get("Allow once")!;
    await screen.rerender(actions({ onRespondToApproval: next }));
    await act(async () => stale());
    expect(first).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    await act(async () => button(screen.container, "Allow once").click());
    expect(next).toHaveBeenCalledWith(requestId, "accept");
    const oldRequest = harness.handlers.get("Allow once")!;
    await screen.rerender(
      actions({ requestId: RuntimeRequestId.make("approval-new"), onRespondToApproval: next }),
    );
    await act(async () => oldRequest());
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("keeps provider fallback labels and sends their unchanged decision", async () => {
    using _fixture = testFixture();

    await using screen = await render(
      actions({
        options: [
          {
            decision: "accept",
            label: "Provider allows once",
            warning: "Session grants are unavailable.",
          },
        ],
      }),
    );
    await act(async () => button(screen.container, "Provider allows once").click());
    expect(respond).toHaveBeenCalledWith(requestId, "accept");
    expect(screen.container.textContent).not.toContain("Deny");
  });
  it("retains the request and allows retry after a rejected response without claiming execution", async () => {
    using _fixture = testFixture();

    respond.mockRejectedValueOnce(new Error("private transport detail"));
    await using screen = await render(actions());
    await act(async () => button(screen.container, "Allow once").click());
    expect(screen.container.textContent).toContain("The request is still pending");
    expect(screen.container.textContent).not.toContain("private transport detail");
    await act(async () => button(screen.container, "Allow once").click());
    expect(respond).toHaveBeenCalledTimes(2);
  });
  it("does not send decisions after connection permission is revoked", async () => {
    using _fixture = testFixture();

    await using screen = await render(actions());
    const stale = harness.handlers.get("Allow once")!;
    await screen.rerender(actions({ disabled: true }));
    await act(async () => stale());
    expect(respond).not.toHaveBeenCalled();
  });
});

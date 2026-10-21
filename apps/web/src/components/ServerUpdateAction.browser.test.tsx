import { ServerUpdateProgress } from "./ServerUpdateProgress";
import { RegistryContext } from "@effect/atom-react";
import { AuthSessionState, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, type Screen } from "../../test/render";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
const testState = vi.hoisted(() => ({
  updateServer: vi.fn(),
  toast: vi.fn(),
  clipboard: vi.fn(),
  continueThreadsAfterServerUpdate: false,
  sessionAtom: null as unknown,
}));

vi.mock(import("~/hooks/useCopyToClipboard"), async (original) => ({
  ...(await original()),
  useCopyToClipboard: ((options: { onCopy: (context: { command: string }) => void }) => ({
    copyToClipboard: (command: string, context: { command: string }) => {
      testState.clipboard(command);
      options.onCopy(context);
    },
    isCopied: false,
  })) as never,
}));
vi.mock(import("~/hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((
    _environmentId: EnvironmentId,
    selector: (settings: { continueThreadsAfterServerUpdate: boolean }) => unknown,
  ) =>
    selector({
      continueThreadsAfterServerUpdate: testState.continueThreadsAfterServerUpdate,
    })) as never,
}));
vi.mock(import("~/state/session"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSession: {
      ...actual.environmentSession,
      sessionStateAtom: (() => testState.sessionAtom) as never,
    },
  };
});
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.updateServer) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: testState.toast } };
});

import {
  registerConfirmDialogHost,
  readConfirmDialogState,
  respondToConfirmDialog,
  resetConfirmDialogForTests,
} from "~/confirmDialog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  ServerUpdateAction,
  ServerUpdatesAction,
  type ServerUpdateTarget,
} from "./ServerUpdateAction";

const decodeSessionState = Schema.decodeUnknownSync(AuthSessionState);

const legacyAuth = {
  policy: "remote-reachable",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} as const;

const currentSession = {
  authenticated: true,
  scopes: ["environment:maintain"],
  auth: {
    ...legacyAuth,
    serverUpdateScope: "environment:maintain",
  },
} as const satisfies AuthSessionState;

const success = (method: "boot-service" | "desktop-app" = "boot-service", version = "0.0.31") =>
  AsyncResult.success({ targetVersion: version, method });

let sessionAtom: Atom.Writable<SessionResult>;

function setSession(session: SessionResult) {
  appAtomRegistry.set(sessionAtom, session);
}

function setup(): Disposable {
  testState.updateServer.mockReset();
  testState.toast.mockReset();
  testState.clipboard.mockReset();
  testState.continueThreadsAfterServerUpdate = false;
  sessionAtom = Atom.make<SessionResult>(AsyncResult.success(currentSession));
  testState.sessionAtom = sessionAtom;
  resetConfirmDialogForTests();
  return { [Symbol.dispose]: resetConfirmDialogForTests };
}

function renderUpdate(element: ReactNode) {
  return render(
    <RegistryContext.Provider value={appAtomRegistry}>{element}</RegistryContext.Provider>,
  );
}

function button(screen: Screen, name?: string) {
  const buttons = [...screen.container.querySelectorAll("button")];
  return name === undefined
    ? buttons[0]
    : buttons.find((element) => element.textContent?.trim() === name);
}

async function click(screen: Screen, name?: string) {
  await act(async () => button(screen, name)!.click());
}

function renderAction(props: Partial<Parameters<typeof ServerUpdateAction>[0]> = {}) {
  return renderUpdate(
    <ServerUpdateAction
      environmentId={"env-test" as EnvironmentId}
      serverLabel="Test server"
      selfUpdate="boot-service"
      targetVersion="0.0.31"
      {...props}
    />,
  );
}

describe("ServerUpdateAction", () => {
  it.each([
    { serverUpdateScope: undefined, scopes: ["orchestration:operate"], allowed: true },
    { serverUpdateScope: undefined, scopes: ["orchestration:read"], allowed: false },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["orchestration:operate"],
      allowed: false,
    },
    {
      serverUpdateScope: "environment:maintain",
      scopes: ["environment:maintain"],
      allowed: true,
    },
  ] as const)(
    "uses the advertised update scope $serverUpdateScope with grant $scopes",
    async ({ serverUpdateScope, scopes, allowed }) => {
      using _state = setup();
      setSession(
        AsyncResult.success(
          decodeSessionState({
            ...currentSession,
            scopes,
            auth: {
              ...legacyAuth,
              ...(serverUpdateScope === undefined ? {} : { serverUpdateScope }),
            },
          }),
        ),
      );
      testState.updateServer.mockResolvedValue(success());

      await using screen = await renderAction();
      expect(button(screen, "Update")!.disabled).toBe(!allowed);
      await click(screen, "Update");

      expect(testState.updateServer).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it("disables the action once maintenance access is removed", async () => {
    using _state = setup();
    await using screen = await renderAction();
    await act(() => setSession(AsyncResult.success({ ...currentSession, scopes: [] })));
    expect(button(screen, "Update")!.disabled).toBe(true);
    await click(screen, "Update");
    expect(testState.updateServer).not.toHaveBeenCalled();
  });
});

describe("ServerUpdatesAction", () => {
  const targets: ReadonlyArray<ServerUpdateTarget> = [
    {
      environmentId: "batch-a" as EnvironmentId,
      serverLabel: "Laptop",
      selfUpdate: "boot-service",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: true,
    },
    {
      environmentId: "batch-b" as EnvironmentId,
      serverLabel: "Office",
      selfUpdate: "respawn",
      targetVersion: "0.0.31",
      threadContinuation: true,
      continueThreadsAfterServerUpdate: false,
    },
    {
      environmentId: "batch-c" as EnvironmentId,
      serverLabel: "Manual",
      selfUpdate: null,
      targetVersion: "0.0.31",
    },
  ];

  const mount = (batch = targets) => renderUpdate(<ServerUpdatesAction targets={batch} />);

  it("names a failed machine while letting the other machine complete", async () => {
    using _state = setup();
    testState.updateServer
      .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Download failed"))))
      .mockResolvedValueOnce(success());
    await using screen = await mount();
    await click(screen, "Update all");

    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(testState.toast).toHaveBeenCalledWith({
      type: "error",
      title: "Laptop update failed",
      description: "Download failed",
    });
    expect(testState.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Office updated" }),
    );
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });

  it("starts each machine once when double-clicked and disables the action until both finish", async () => {
    using _state = setup();
    const completions: Array<() => void> = [];
    testState.updateServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(() => resolve(success()));
        }),
    );
    await using screen = await mount();
    await act(async () => {
      button(screen, "Update all")!.click();
      button(screen, "Update all")!.click();
    });
    expect(testState.updateServer).toHaveBeenCalledTimes(2);
    expect(button(screen, "Update all")!.disabled).toBe(true);
    await act(async () => completions[0]!());
    expect(button(screen, "Update all")!.disabled).toBe(true);
    await act(async () => completions[1]!());
    expect(button(screen, "Update all")!.disabled).toBe(false);
    expect(testState.toast).toHaveBeenCalledTimes(2);
  });

  it("asks once for desktop machines and cancels the entire batch", async () => {
    using _state = setup();
    registerConfirmDialogHost();
    await using screen = await mount(
      targets.map((target, index) =>
        index < 2 ? { ...target, selfUpdate: "desktop-managed", desktopAppUpdate: true } : target,
      ),
    );
    await click(screen, "Update all");
    expect(readConfirmDialogState()).toEqual(
      expect.objectContaining({
        status: "confirming",
        message: expect.stringContaining("Laptop, Office"),
      }),
    );
    expect(testState.updateServer).not.toHaveBeenCalled();
    await act(async () => respondToConfirmDialog(false));
    expect(testState.updateServer).not.toHaveBeenCalled();
    expect(button(screen, "Update all")!.disabled).toBe(false);
  });
});

describe("ServerUpdateProgress", () => {
  it("shows one calm status for the restart wait", async () => {
    using _state = setup();
    await using screen = await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "resuming",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(screen.container.textContent).toBe("Restarting…");
    // The wait state is monochrome and calm: no versions, no step rail, no
    // success/warning colors, and a static dot that never repaints.
    expect(screen.container.innerHTML).not.toContain("0.0.30");
    expect(screen.container.innerHTML).not.toContain("Resum");
    expect(screen.container.innerHTML).not.toContain("text-success");
    expect(screen.container.innerHTML).not.toContain("text-primary");
    expect(screen.container.innerHTML).not.toContain("animate-");
  });

  it("folds the sub-second installing handoff into the download phase", async () => {
    using _state = setup();
    await using screen = await render(
      <ServerUpdateProgress
        state={{
          status: "running",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
        }}
      />,
    );
    expect(screen.container.textContent).toBe("Downloading…");
  });

  it("keeps the failure visible as an alert with its error", async () => {
    using _state = setup();
    await using screen = await render(
      <ServerUpdateProgress
        state={{
          status: "failed",
          stage: "installing",
          fromVersion: "0.0.30",
          targetVersion: "0.0.31",
          message: "The package could not be verified.",
        }}
      />,
    );
    expect(screen.container.querySelector("[role=alert]")?.textContent).toBe(
      "The package could not be verified.",
    );
  });
});

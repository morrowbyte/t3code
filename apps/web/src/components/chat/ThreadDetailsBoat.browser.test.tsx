import { RegistryContext } from "@effect/atom-react";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  BoatError,
  DEFAULT_BOAT_DEFAULTS,
  DEFAULT_BOAT_PROJECT,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BoatInstance,
  type BoatState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { boatEnvironment } from "../../state/boat";

type ReadRequest = Parameters<typeof boatEnvironment.read.run>[1];
type OperateRequest = Parameters<typeof boatEnvironment.operate.run>[1];
type CommandResult = AtomCommandResult<BoatState, BoatError>;

const fixture = vi.hoisted(() => ({
  read: vi.fn<(request: ReadRequest) => Promise<CommandResult>>(),
  operate: vi.fn<(request: OperateRequest) => Promise<CommandResult>>(),
}));

vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => "2026-11-01T12:00" }));
vi.mock("../../state/environments", () => {
  const environment = { connection: { phase: "connected" } };
  return { useEnvironment: () => environment };
});
vi.mock("../../state/session", async () => {
  const Option = await import("effect/Option");
  const prepared = Option.some({});
  return { usePreparedConnection: () => prepared };
});
vi.mock("../../state/boat", async () => {
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    boatEnvironment: {
      read: { label: "boat:read", permissionAtom: () => allowed },
      operate: { label: "boat:operate", permissionAtom: () => allowed },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) => {
    switch (command.label) {
      case "boat:read":
        return fixture.read;
      case "boat:operate":
        return fixture.operate;
      default:
        throw new Error(`Unexpected command: ${command.label}`);
    }
  },
}));

import "~/index.css";
import { ThreadDetailsBoat } from "./ThreadDetailsBoat";

const environmentId = EnvironmentId.make("boat-browser");
const projectId = ProjectId.make("boat-project");
const threadId = ThreadId.make("current-thread");
const now = Date.parse("2026-11-01T12:00:00Z");

function machine(requestId: string, owner: ThreadId): BoatInstance {
  return {
    requestId,
    projectId,
    sandboxId: `vm-${requestId}`,
    threadId: owner,
    size: "default",
    state: "running",
    createdAt: "2026-11-01T12:00:00Z",
    expiresAt: "2026-11-01T13:00:00Z",
    leases: [],
    stoppedAt: null,
    previewTabId: null,
    costUsd: 0,
    snapshot: "",
    savedSnapshot: null,
    processId: null,
    deletionOperationId: null,
    output: "",
    previewUrl: null,
  };
}

function setup() {
  fixture.read.mockReset();
  fixture.operate.mockReset();
  let state: BoatState = {
    defaults: DEFAULT_BOAT_DEFAULTS,
    configured: true,
    account: null,
    projects: { [projectId]: DEFAULT_BOAT_PROJECT },
    instances: [machine("other", ThreadId.make("other-thread"))],
  };
  let failStop = true;
  const conflict = () => AsyncResult.failure(Cause.fail(new BoatError({ category: "conflict" })));
  fixture.read.mockImplementation(async (request) =>
    request.environmentId === environmentId && request.input.projectId === projectId
      ? AsyncResult.success(state)
      : conflict(),
  );
  fixture.operate.mockImplementation(
    async ({ environmentId: targetEnvironment, input: action }) => {
      if (
        targetEnvironment !== environmentId ||
        action.projectId !== projectId ||
        action.threadId !== threadId
      )
        return conflict();
      if (action.action === "start" || action.action === "renew") {
        if (!action.ttlMinutes) return conflict();
        const owned = state.instances.find((instance) => instance.requestId === action.requestId);
        const updated = {
          ...(owned ?? machine(action.requestId, threadId)),
          sandboxId: "vm-current",
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + action.ttlMinutes * 60_000)),
        };
        state = {
          ...state,
          instances: [
            ...state.instances.filter((item) => item.requestId !== action.requestId),
            updated,
          ],
        };
      } else if (action.action === "stop") {
        if (failStop) {
          failStop = false;
          return AsyncResult.failure(
            Cause.fail(new BoatError({ category: "provider", status: 503 })),
          );
        }
        state = {
          ...state,
          instances: state.instances.map((item) =>
            item.requestId === action.requestId ? { ...item, state: "stopped" } : item,
          ),
        };
      } else return conflict();
      return AsyncResult.success(state);
    },
  );
}

it("manages only this thread's VMs with an explicit runtime and recovers after a failed stop", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <ThreadDetailsBoat environmentId={environmentId} projectId={projectId} threadId={threadId} />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("No Boats owned by this thread.")).toBeVisible();
  await expect.element(screen.getByText("vm-other", { exact: true })).not.toBeInTheDocument();
  const runtime = screen.getByRole("spinbutton", { name: "Runtime" });
  await runtime.fill("30");
  await screen.getByRole("button", { name: "Start", exact: true }).click();
  await expect.element(screen.getByText("vm-current", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("30 min left", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Boats · 1" })).toBeVisible();
  await runtime.fill("45");
  await screen.getByRole("button", { name: "Renew vm-current for 45 minutes" }).click();
  await expect.element(screen.getByText("45 min left", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Stop vm-current" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Boat could not complete the request (HTTP 503).");
  await expect.element(screen.getByRole("button", { name: "Stop vm-current" })).toBeEnabled();
  await screen.getByRole("button", { name: "Stop vm-current" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Resume vm-current for 45 minutes" }))
    .toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByText("vm-other", { exact: true })).not.toBeInTheDocument();
});

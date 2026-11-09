import { RegistryContext } from "@effect/atom-react";
import type {
  EnvironmentRegistry as ConnectionRegistry,
  EnvironmentSupervisor as ConnectionSupervisor,
} from "@t3tools/client-runtime/connection";
import {
  BoatError,
  DEFAULT_BOAT_DEFAULTS,
  DEFAULT_BOAT_PROJECT,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BoatAction,
  type BoatInstance,
  type BoatState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const fixture = vi.hoisted(() => ({
  read: undefined as (() => BoatState) | undefined,
  operate: undefined as ((input: BoatAction) => BoatState) | undefined,
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
vi.mock("@t3tools/client-runtime/state/session", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const { AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthPreviewOperateScope } =
    await import("@t3tools/contracts");
  const scopes = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthPreviewOperateScope,
  ];
  const session = Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "fixture",
      },
      scopes,
      permissions: scopes,
    }),
  );
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: () => session }) };
});
vi.mock("../../state/boat", async () => {
  const { createBoatEnvironment } = await import("@t3tools/client-runtime/state/boat");
  const connection = await import("@t3tools/client-runtime/connection");
  const { EnvironmentRegistry } = connection.EnvironmentRegistry;
  const { EnvironmentSupervisor } = connection.EnvironmentSupervisor;
  const { AVAILABLE_CONNECTION_STATE } = connection;
  const { EnvironmentId, BoatError, WS_METHODS } = await import("@t3tools/contracts");
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const runtime = Atom.runtime(
    Layer.effect(
      EnvironmentRegistry,
      Effect.gen(function* () {
        const client = {
          [WS_METHODS.boatRead]: () => Effect.sync(() => fixture.read!()),
          [WS_METHODS.boatOperate]: (input: BoatAction) =>
            Effect.try({
              try: () => fixture.operate!(input),
              catch: (cause) =>
                cause instanceof BoatError ? cause : new BoatError({ category: "provider" }),
            }),
        };
        const supervisor = {
          target: { environmentId: EnvironmentId.make("boat-browser"), label: "Boat fixture" },
          session: yield* SubscriptionRef.make(Option.some({ client })),
          state: yield* SubscriptionRef.make({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }),
        } as unknown as ConnectionSupervisor.EnvironmentSupervisor["Service"];
        return {
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        } as ConnectionRegistry.EnvironmentRegistry["Service"];
      }),
    ),
  );
  return { boatEnvironment: createBoatEnvironment(runtime) };
});

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
  fixture.read = undefined;
  fixture.operate = undefined;
}

it("manages only this thread's VMs with an explicit runtime and recovers after a failed stop", async () => {
  setup();
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  let state: BoatState = {
    defaults: DEFAULT_BOAT_DEFAULTS,
    configured: true,
    account: null,
    projects: { [projectId]: DEFAULT_BOAT_PROJECT },
    instances: [machine("other", ThreadId.make("other-thread"))],
  };
  let failStop = true;
  fixture.read = () => state;
  fixture.operate = (action) => {
    if (action.projectId !== projectId || action.threadId !== threadId)
      throw new BoatError({ category: "conflict" });
    if (action.action === "start" || action.action === "renew") {
      if (!action.ttlMinutes) throw new BoatError({ category: "conflict" });
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
        throw new BoatError({ category: "provider", status: 503 });
      }
      state = {
        ...state,
        instances: state.instances.map((item) =>
          item.requestId === action.requestId ? { ...item, state: "stopped" } : item,
        ),
      };
    } else throw new BoatError({ category: "conflict" });
    return state;
  };
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
  await expect.element(screen.getByRole("alert")).toHaveTextContent("503");
  await expect.element(screen.getByRole("button", { name: "Stop vm-current" })).toBeEnabled();
  await screen.getByRole("button", { name: "Stop vm-current" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Resume vm-current for 45 minutes" }))
    .toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByText("vm-other", { exact: true })).not.toBeInTheDocument();
});

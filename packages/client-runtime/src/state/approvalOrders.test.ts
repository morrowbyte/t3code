import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  MessageId,
  ThreadId,
  WS_METHODS,
  type ApprovalReviewHostOrder,
  type ApprovalReviewOrderCreate,
  type ApprovalReviewOrderReadiness,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  approvalOrderDestinationChannels,
  approvalOrderSourceIsReady,
  createApprovalOrderEnvironmentAtoms,
} from "./approvalOrders.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));

const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const host = EnvironmentId.make("host-test");
const other = EnvironmentId.make("other-test");
const input: ApprovalReviewOrderCreate = {
  clientRequestId: "send-test",
  sourceThreadId: ThreadId.make("host-thread"),
  vmId: "paired-test-vm",
  text: "  Keep this original exactly.\nSecond line.  ",
  expiresAt: 2_000_000_000_000,
};
const order: ApprovalReviewHostOrder = {
  source: {
    version: 2,
    orderId: "order-test",
    orderRevision: 1,
    sourceKind: "synthetic",
    testOnly: true,
    sourceEnvironmentId: host,
    sessionId: AuthSessionId.make("synthetic-session"),
    principal: "synthetic-subject",
    threadId: input.sourceThreadId,
    messageId: MessageId.make("host-message"),
    createdAt: 1,
    expiresAt: input.expiresAt,
    fullText: input.text,
    fullTextHash: "a".repeat(64),
    originalLink: "host-order:order-test",
  },
  vmId: input.vmId,
  targetThreadId: ThreadId.make("vm-thread"),
  state: "forward-unknown",
  assignment: null,
  forwardRevision: 0,
};

function grant(permissions: readonly AuthEnvironmentScope[]): AuthSessionState {
  return {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: permissions,
    permissions,
  };
}

async function setup() {
  const calls: { method: string; input: unknown }[] = [];
  const readiness: ApprovalReviewOrderReadiness = {
    enabled: false,
    reason: "human-authority-required",
    channels: [],
  };
  const record = (method: string, payload: unknown, value: unknown) =>
    Effect.sync(() => {
      calls.push({ method, input: payload });
      return value;
    });
  const session = {
    client: {
      [WS_METHODS.approvalReviewOrderCreate]: (payload: unknown) =>
        record(WS_METHODS.approvalReviewOrderCreate, payload, order),
      [WS_METHODS.approvalReviewOrderRead]: (payload: unknown) =>
        record(WS_METHODS.approvalReviewOrderRead, payload, order),
      [WS_METHODS.approvalReviewOrderCancel]: (payload: unknown) =>
        record(WS_METHODS.approvalReviewOrderCancel, payload, {
          ...order,
          state: "cancelled",
          alreadyClaimedActions: [],
        }),
      [WS_METHODS.approvalReviewOrderReadiness]: (payload: unknown) =>
        record(WS_METHODS.approvalReviewOrderReadiness, payload, readiness),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: host, label: "Test host" },
    session: await Effect.runPromise(SubscriptionRef.make(Option.some(session))),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      run: (_environmentId: EnvironmentId, effect: Effect.Effect<unknown>) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  registry.mount(sessions(host));
  registry.mount(sessions(other));
  registry.set(sessions(host), AsyncResult.success(grant([])));
  registry.set(sessions(other), AsyncResult.success(grant([])));
  return {
    registry,
    calls,
    commands: createApprovalOrderEnvironmentAtoms(runtime),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

describe("approval order guarded transport", () => {
  it("blocks sends without the host grant and rechecks permission at execution", async () => {
    using harness = await setup();
    const { registry, commands, calls } = harness;
    expect(registry.get(commands.create.permissionAtom(host))).toBe(false);
    expect((await commands.create.run(registry, { environmentId: host, input }))._tag).toBe(
      "Failure",
    );
    expect(calls).toEqual([]);
    registry.set(sessions(host), AsyncResult.success(grant([AuthOrchestrationOperateScope])));
    expect(registry.get(commands.create.permissionAtom(host))).toBe(true);
    expect((await commands.create.run(registry, { environmentId: host, input }))._tag).toBe(
      "Success",
    );
    expect(calls).toEqual([{ method: WS_METHODS.approvalReviewOrderCreate, input }]);
    registry.set(sessions(host), AsyncResult.success(grant([])));
    expect((await commands.create.run(registry, { environmentId: host, input }))._tag).toBe(
      "Failure",
    );
    expect(calls).toHaveLength(1);
  });

  it("does not borrow a different environment's operate grant", async () => {
    using harness = await setup();
    harness.registry.set(
      sessions(other),
      AsyncResult.success(grant([AuthOrchestrationOperateScope])),
    );
    expect(harness.registry.get(harness.commands.create.permissionAtom(host))).toBe(false);
    expect(
      (await harness.commands.create.run(harness.registry, { environmentId: host, input }))._tag,
    ).toBe("Failure");
    expect(harness.calls).toEqual([]);
  });

  it("allows read/readiness with read permission and requires operate to cancel", async () => {
    using harness = await setup();
    const { registry, commands, calls } = harness;
    const target = { environmentId: host, input: { orderId: order.source.orderId } };
    expect(registry.get(commands.read.permissionAtom(host))).toBe(false);
    expect(registry.get(commands.readiness.permissionAtom(host))).toBe(false);
    expect((await commands.read.run(registry, target))._tag).toBe("Failure");
    expect((await commands.readiness.run(registry, { environmentId: host, input: {} }))._tag).toBe(
      "Failure",
    );
    expect(calls).toEqual([]);
    registry.set(sessions(host), AsyncResult.success(grant([AuthOrchestrationReadScope])));
    expect(registry.get(commands.cancel.permissionAtom(host))).toBe(false);
    expect((await commands.cancel.run(registry, target))._tag).toBe("Failure");
    expect((await commands.read.run(registry, target))._tag).toBe("Success");
    const readiness = await commands.readiness.run(registry, { environmentId: host, input: {} });
    expect(readiness).toMatchObject({
      _tag: "Success",
      value: { enabled: false, reason: "human-authority-required" },
    });
    registry.set(sessions(host), AsyncResult.success(grant([AuthOrchestrationOperateScope])));
    expect((await commands.cancel.run(registry, target))._tag).toBe("Success");
    expect(calls.map((call) => call.method)).toEqual([
      WS_METHODS.approvalReviewOrderRead,
      WS_METHODS.approvalReviewOrderReadiness,
      WS_METHODS.approvalReviewOrderCancel,
    ]);
  });

  it("preserves unknown state, exact original and request identity without retrying", async () => {
    using harness = await setup();
    harness.registry.set(
      sessions(host),
      AsyncResult.success(grant([AuthOrchestrationOperateScope])),
    );
    const result = await harness.commands.create.run(harness.registry, {
      environmentId: host,
      input,
    });
    expect(result).toMatchObject({
      _tag: "Success",
      value: {
        state: "forward-unknown",
        assignment: null,
        source: { fullText: input.text, sourceKind: "synthetic", testOnly: true },
      },
    });
    expect(harness.calls).toEqual([{ method: WS_METHODS.approvalReviewOrderCreate, input }]);
  });
});

it("requires explicit, consistent backend source qualification in addition to scopes", () => {
  const base: ApprovalReviewOrderReadiness = { enabled: true, reason: "ready", channels: [] };
  expect(approvalOrderSourceIsReady(null)).toBe(false);
  expect(approvalOrderSourceIsReady(base)).toBe(false);
  expect(approvalOrderSourceIsReady({ ...base, sourceKind: "human" })).toBe(false);
  expect(approvalOrderSourceIsReady({ ...base, sourceKind: "human", testOnly: false })).toBe(true);
  expect(approvalOrderSourceIsReady({ ...base, sourceKind: "human", testOnly: true })).toBe(false);
  expect(approvalOrderSourceIsReady({ ...base, sourceKind: "synthetic", testOnly: true })).toBe(
    true,
  );
  expect(approvalOrderSourceIsReady({ ...base, sourceKind: "synthetic", testOnly: false })).toBe(
    false,
  );
  expect(
    approvalOrderSourceIsReady({ ...base, sourceKind: "human", testOnly: false, enabled: false }),
  ).toBe(false);
});

it("matches both destination identities and preserves the host-owned control thread", () => {
  const destination: ScopedThreadRef = {
    environmentId: EnvironmentId.make("vm-destination"),
    threadId: ThreadId.make("vm-thread"),
  };
  const matching: ApprovalReviewOrderReadiness["channels"][number] = {
    hostThreadId: input.sourceThreadId,
    vmId: input.vmId,
    label: "Exact destination",
    ...destination,
    ready: true,
    reason: "ready",
  };
  const readiness: ApprovalReviewOrderReadiness = {
    enabled: true,
    reason: "ready",
    sourceKind: "synthetic",
    testOnly: true,
    channels: [
      { ...matching, environmentId: host, label: "Wrong environment" },
      { ...matching, threadId: ThreadId.make("foreign-thread"), label: "Wrong thread" },
      matching,
    ],
  };
  expect(approvalOrderDestinationChannels(null, destination)).toEqual([]);
  expect(approvalOrderDestinationChannels(readiness, destination)).toEqual([matching]);
  expect(matching.hostThreadId).not.toBe(destination.threadId);
  expect(
    approvalOrderDestinationChannels(
      { ...readiness, channels: readiness.channels.slice(0, 2) },
      destination,
    ),
  ).toEqual([]);
});

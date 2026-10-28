import { describe, expect, it } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  EnvironmentId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Commands from "./PrivilegedCommandCommands.ts";
import { privilegedCommandHash } from "./PrivilegedCommandPackage.ts";

const threadId = ThreadId.make("thread-test"),
  runId = RunId.make("run-test"),
  requestId = RuntimeRequestId.make("privileged-command:test");
const bundle = {
  environmentId: EnvironmentId.make("environment-test"),
  threadId,
  runId,
  providerSessionId: "session",
  purpose: "Repair",
  script: "printf hello\n",
  shell: "sh" as const,
  cwd: "/tmp",
  timeoutMs: 1000,
};
const packageHash = privilegedCommandHash(requestId, bundle);
const authority = { bundle, packageHash, state: "pending" as const };
const request = {
  id: requestId,
  nodeId: NodeId.make("node-test"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "command" as const,
  status: "pending" as const,
  responseCapability: { type: "external" as const },
  createdAt: DateTime.makeUnsafe(0),
  resolvedAt: null,
  privilegedCommand: authority,
};
const response = {
  type: "runtime-request.respond" as const,
  threadId,
  requestId,
  commandId: CommandId.make("response"),
  decision: "accept" as const,
  packageHash,
};
const human = {
  sessionId: AuthSessionId.make("human"),
  subject: "owner",
  method: "browser-session-cookie" as const,
};

effectIt.effect("keeps a claimed approval waiting until cleanup is confirmed", () =>
  Effect.gen(function* () {
    const claimed = {
      ...request,
      status: "resolved" as const,
      decision: "accept" as const,
      privilegedCommand: { ...authority, state: "claimed" as const, claimId: "claim-test" },
    };
    let current: unknown = claimed;
    let item: unknown = { type: "approval_request", status: "running", completedAt: null };
    const store = {
      getThreadRecords: () => Effect.succeed({ runtimeRequests: [current] }),
      getRuntimeResponseContext: () => Effect.succeed({ request: current, item }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    const stopped = yield* Commands.stop({ threadId }).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
    );
    const requestEvent = stopped.find((event) => event.type === "runtime-request.updated");
    const itemEvent = stopped.find((event) => event.type === "turn-item.updated");
    if (!requestEvent || !itemEvent || itemEvent.type !== "turn-item.updated")
      throw new Error("missing stop updates");
    current = requestEvent.payload;
    item = itemEvent.payload;
    expect((itemEvent.payload as { status: string }).status).toBe("waiting");
    expect((itemEvent.payload as { completedAt: unknown }).completedAt).toBeNull();
    const recovered = yield* Commands.plan({
      type: "privileged-command.cleanup-visible",
      commandId: CommandId.make("recovery-receipt"),
      threadId,
      requestId,
      packageHash,
      claimId: "claim-test",
    }).pipe(Effect.provideService(ProjectionStore.ProjectionStoreV2, store));
    const recoveredItem = recovered.find((event) => event.type === "turn-item.updated");
    if (!recoveredItem || recoveredItem.type !== "turn-item.updated")
      throw new Error("missing recovery confirmation");
    expect((recoveredItem.payload as { status: string }).status).toBe("cancelled");
    const result = yield* Commands.plan({
      type: "privileged-command.result",
      commandId: CommandId.make("stop-receipt"),
      threadId,
      requestId,
      packageHash,
      claimId: "claim-test",
      cleanupConfirmed: true,
      result: { status: "unknown", exitCode: null, stdout: "", stderr: "stopped" },
    }).pipe(Effect.provideService(ProjectionStore.ProjectionStoreV2, store));
    const confirmedItem = result.find((event) => event.type === "turn-item.updated");
    if (!confirmedItem || confirmedItem.type !== "turn-item.updated")
      throw new Error("missing confirmed item");
    expect((confirmedItem.payload as { status: string }).status).toBe("cancelled");
    expect((confirmedItem.payload as { completedAt: unknown }).completedAt).not.toBeNull();
  }),
);

effectIt.effect("closes unclaimed privileged requests when their run ends", () =>
  Effect.gen(function* () {
    const claimed = {
      ...request,
      id: RuntimeRequestId.make("claimed"),
      privilegedCommand: { ...authority, state: "claimed" as const, claimId: "claim" },
    };
    const store = {
      getThreadRecords: () => Effect.succeed({ runtimeRequests: [request, claimed] }),
      getRuntimeResponseContext: (_threadId: unknown, id: unknown) =>
        Effect.succeed({
          request: id === requestId ? request : claimed,
          item: undefined,
          node: undefined,
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    const events = yield* Commands.stop({ threadId, runId, onlyUnclaimed: true }).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
    );
    const updates = events.filter((event) => event.type === "runtime-request.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toMatchObject({
      id: requestId,
      status: "cancelled",
      privilegedCommand: { state: "rejected" },
    });
  }),
);

effectIt.effect(
  "closes an approved but unclaimed request without touching a claimed execution",
  () =>
    Effect.gen(function* () {
      const approvedId = RuntimeRequestId.make("approved-race");
      const claimedId = RuntimeRequestId.make("claimed-race");
      const approved = {
        ...request,
        id: approvedId,
        status: "resolved" as const,
        privilegedCommand: { ...authority, state: "approved" as const },
      };
      const claimed = {
        ...request,
        id: claimedId,
        status: "resolved" as const,
        privilegedCommand: { ...authority, state: "claimed" as const, claimId: "claim" },
      };
      const store = {
        getThreadRecords: () => Effect.succeed({ runtimeRequests: [approved, claimed] }),
        getRuntimeResponseContext: (_threadId: unknown, id: unknown) =>
          Effect.succeed({
            request: id === approvedId ? approved : claimed,
            item: { type: "approval_request", status: "waiting", completedAt: null },
            node: undefined,
          }),
      } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
      const events = yield* Commands.stop({ threadId, runId, onlyUnclaimed: true }).pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
      );
      expect(events.filter((event) => event.type === "runtime-request.updated")).toHaveLength(1);
      expect(events.find((event) => event.type === "turn-item.updated")?.payload).toMatchObject({
        status: "cancelled",
        privilegedCommand: { state: "unknown" },
      });
    }),
);

effectIt.effect("closes an unclaimed approval when a claim cannot start", () =>
  Effect.gen(function* () {
    const approved = {
      ...request,
      status: "resolved" as const,
      decision: "accept" as const,
      privilegedCommand: { ...authority, state: "approved" as const },
    };
    const store = {
      getRuntimeResponseContext: () =>
        Effect.succeed({
          request: approved,
          item: { type: "approval_request", status: "waiting", completedAt: null },
        }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    const events = yield* Commands.plan({
      type: "privileged-command.unconfirmed",
      commandId: CommandId.make("unconfirmed-race"),
      threadId,
      requestId,
      packageHash,
      claimId: "claim",
    }).pipe(Effect.provideService(ProjectionStore.ProjectionStoreV2, store));
    expect(events.find((event) => event.type === "turn-item.updated")?.payload).toMatchObject({
      status: "cancelled",
      privilegedCommand: { state: "unknown" },
    });
  }),
);

describe("privileged command approval", () => {
  it("requires a browser session, exact hash, and one-shot acceptance", async () => {
    const resolve = (command: typeof response, actor?: typeof human) =>
      Commands.resolve(request, command).pipe(
        Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, actor),
        Effect.runPromiseExit,
      );
    expect(Exit.isFailure(await resolve(response))).toBe(true);
    expect(Exit.isFailure(await resolve({ ...response, packageHash: "0".repeat(64) }, human))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        await resolve({ ...response, decision: "acceptForSession" as "accept" }, human),
      ),
    ).toBe(true);
    const accepted = await resolve(response, human);
    expect(Exit.isSuccess(accepted) && accepted.value.state).toBe("approved");
    expect(privilegedCommandHash(requestId, { ...bundle, script: `${bundle.script} ` })).not.toBe(
      packageHash,
    );
    expect(privilegedCommandHash(RuntimeRequestId.make("other"), bundle)).not.toBe(packageHash);
  });
  it("accepts an environment-scoped DPoP session for a reviewed request", async () => {
    const result = await Commands.resolve(request, response).pipe(
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        ...human,
        method: "dpop-access-token",
      }),
      Effect.runPromiseExit,
    );
    expect(Exit.isSuccess(result) && result.value.state).toBe("approved");
  });
  it("does not treat an ordinary bearer session as a human approval", async () => {
    const result = await Commands.resolve(request, response).pipe(
      Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
        ...human,
        method: "bearer-access-token",
      }),
      Effect.runPromiseExit,
    );
    expect(Exit.isFailure(result)).toBe(true);
  });
  it("claims an approved request once and refuses rejected, changed, and claimed requests", async () => {
    let current = {
      ...request,
      status: "resolved" as const,
      decision: "accept" as "accept" | "decline",
      privilegedCommand: { ...authority, state: "approved" as "approved" | "rejected" | "claimed" },
    };
    const store = {
      getRuntimeResponseContext: () => Effect.succeed({ request: current, item: undefined }),
      getRunningTurnContext: () => Effect.succeed({ run: { id: runId } }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
    const claim = () =>
      Commands.plan({
        type: "privileged-command.claim",
        claimId: "claim-test",
        recoveryIdentity: {
          platform: "linux",
          bootId: "test-boot",
          processId: 123,
          processStart: "start-fixture",
        },
        commandId: CommandId.make("claim"),
        threadId,
        requestId,
        packageHash,
      }).pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
        Effect.runPromiseExit,
      );
    const first = await claim();
    expect(Exit.isSuccess(first)).toBe(true);
    if (!Exit.isSuccess(first)) throw new Error("claim failed");
    const update = first.value.find((event) => event.type === "runtime-request.updated");
    expect(
      update?.type === "runtime-request.updated" &&
        (update.payload as typeof request).privilegedCommand?.state,
    ).toBe("claimed");
    current = { ...current, privilegedCommand: { ...authority, state: "claimed" } };
    expect(Exit.isFailure(await claim())).toBe(true);
    current = {
      ...current,
      decision: "decline",
      privilegedCommand: { ...authority, state: "rejected" },
    };
    expect(Exit.isFailure(await claim())).toBe(true);
    current = {
      ...current,
      decision: "accept",
      privilegedCommand: {
        ...authority,
        bundle: { ...bundle, script: "changed" },
        state: "approved",
      },
    };
    expect(Exit.isFailure(await claim())).toBe(true);
  });
});

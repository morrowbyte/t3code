import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import {
  ApprovalReviewError,
  AuthSessionId,
  CommandId,
  EnvironmentId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HumanAuthority from "../auth/ApprovalReviewHumanAuthority.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Executor from "../privilegedCommands/PrivilegedCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Commands from "./PrivilegedCommandCommands.ts";
import * as Service from "./PrivilegedCommandService.ts";
import * as EventSink from "./EventSink.ts";

describe("privileged command service", () => {
  it.live(
    "executes the approved bytes once and cannot execute again after reconstructing the service",
    () =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("env"),
          threadId = ThreadId.make("thread"),
          runId = RunId.make("run");
        let request: OrchestrationV2RuntimeRequest | undefined;
        let resultWrites = 0;
        let failValidation = true;
        let cleanupConfirmed = false;
        let failClaim = false;
        let failAfterClaimCommit = false;
        let failBeforeRunner = false;
        let lastResultCleanupConfirmed: boolean | undefined;
        let markerFailures = 0;
        let claimAttempts = 0;
        const calls: Executor.PrivilegedCommandInput[] = [];
        const store = {
          getRuntimeResponseContext: () => Effect.succeed({ request, item: undefined }),
          getRuntimeRequest: () => Effect.succeed(request),
          getRunningTurnContext: () =>
            Effect.succeed({
              run: { id: runId, rootNodeId: NodeId.make("root") },
              providerThread: { providerSessionId: "provider-session" },
              providerTurn: {},
            }),
          getNextTurnItemOrdinal: () => Effect.succeed(1),
        } as unknown as ProjectionStore.ProjectionStoreV2["Service"];
        const orchestrator = {
          dispatch: (
            command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
          ) => {
            if (command.type === "privileged-command.claim") {
              claimAttempts += 1;
              if (failClaim) return Effect.fail(new ApprovalReviewError({ reason: "storage" }));
            }
            if (command.type === "privileged-command.result") {
              lastResultCleanupConfirmed = command.cleanupConfirmed;
              if (++resultWrites === 1)
                return Effect.fail(new ApprovalReviewError({ reason: "storage" }));
            }
            if (command.type === "privileged-command.unconfirmed" && markerFailures++ === 0)
              return Effect.fail(new ApprovalReviewError({ reason: "storage" }));
            const applied = Commands.plan(command as Parameters<typeof Commands.plan>[0]).pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, store),
              Effect.map((events) => {
                const event = events.find((entry) => entry.type === "runtime-request.updated");
                if (event) request = event.payload as OrchestrationV2RuntimeRequest;
                return { sequence: 1 };
              }),
            );
            return command.type === "privileged-command.claim" && failAfterClaimCommit
              ? applied.pipe(
                  Effect.andThen(Effect.fail(new ApprovalReviewError({ reason: "storage" }))),
                )
              : applied;
          },
        } as unknown as Orchestrator.OrchestratorV2["Service"];
        const executor = {
          captureRecoveryIdentity: () =>
            Effect.succeed({
              platform: "linux" as const,
              bootId: "test-boot",
              processId: 123,
              processStart: "start-fixture",
            }),
          cleanup: () =>
            Effect.succeed({
              status: cleanupConfirmed ? ("confirmed" as const) : ("unknown" as const),
            }),
          validate: () =>
            failValidation
              ? Effect.fail(
                  new Executor.PrivilegedCommandExecutionError({ reason: "linux-prerequisites" }),
                )
              : Effect.void,
          execute: (input: Executor.PrivilegedCommandInput) => {
            calls.push(input);
            if (failBeforeRunner)
              return Effect.fail(
                new Executor.PrivilegedCommandExecutionError({ reason: "invalid-cwd" }),
              );
            return Effect.succeed({
              status: "succeeded" as const,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
            });
          },
        };
        const deps = Layer.mergeAll(
          Layer.succeed(EventSink.EventSinkV2, {
            latestSequence: () => Effect.succeed(0),
            stream: () =>
              Stream.succeed({
                event: { type: "run.updated", payload: { id: runId, status: "cancelled" } },
              }),
          } as unknown as EventSink.EventSinkV2["Service"]),
          Layer.succeed(ProjectionStore.ProjectionStoreV2, store),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            ownsMcpCredential: ({ providerSessionId, threadId: ownerThreadId, credentialId }) =>
              Effect.succeed(
                providerSessionId === "provider-session" &&
                  ownerThreadId === threadId &&
                  credentialId === "session",
              ),
          }),
          Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
          Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
            getEnvironmentId: Effect.succeed(environmentId),
          }),
          Layer.succeed(Executor.PrivilegedCommandExecutor, executor),
        );
        const layer = Service.layer.pipe(Layer.provide(deps));
        const cleanup = Effect.gen(function* () {
          const service = yield* Service.PrivilegedCommandService;
          return yield* service.cleanup({
            threadId,
            requestId: RuntimeRequestId.make("privileged-command:cleanup"),
            shell: "sh",
            identity: {
              platform: "linux",
              bootId: "test-boot",
              processId: 123,
              processStart: "start-fixture",
            },
          });
        }).pipe(Effect.provide(layer));
        expect(Exit.isFailure(yield* Effect.exit(cleanup))).toBe(true);
        cleanupConfirmed = true;
        yield* cleanup;
        const unsupported = Effect.gen(function* () {
          const service = yield* Service.PrivilegedCommandService;
          return yield* service.propose({
            environmentId,
            threadId,
            providerSessionId: "session",
            purpose: "Repair",
            script: "inert",
            shell: "sh",
            cwd: "/tmp",
            timeoutMs: 1000,
          });
        }).pipe(Effect.provide(layer));
        const preflightError = yield* Effect.flip(unsupported);
        expect(preflightError.reason).toBe("linux-prerequisites");
        expect(preflightError.message).toContain("systemd");
        expect(request).toBeUndefined();
        failValidation = false;
        const wrongCredential = yield* Effect.exit(
          Effect.gen(function* () {
            const service = yield* Service.PrivilegedCommandService;
            return yield* service.propose({
              environmentId,
              threadId,
              providerSessionId: "other",
              purpose: "Repair",
              script: "inert",
              shell: "sh",
              cwd: "/tmp",
              timeoutMs: 1000,
            });
          }).pipe(Effect.provide(layer)),
        );
        expect(Exit.isFailure(wrongCredential)).toBe(true);
        expect(request).toBeUndefined();
        const proposal = yield* Effect.gen(function* () {
          const service = yield* Service.PrivilegedCommandService;
          return yield* service.propose({
            environmentId,
            threadId,
            providerSessionId: "session",
            purpose: "Repair",
            script: "printf approved\\n",
            shell: "sh",
            cwd: "/tmp",
            timeoutMs: 1000,
          });
        }).pipe(Effect.provide(layer));
        if (!request) throw new Error("missing request");
        const interruptedWait = Effect.gen(function* () {
          const service = yield* Service.PrivilegedCommandService;
          return yield* service.wait({
            environmentId,
            threadId,
            providerSessionId: "session",
            requestId: proposal.requestId,
          });
        });
        expect(
          Exit.isFailure(yield* Effect.exit(interruptedWait.pipe(Effect.provide(layer)))),
        ).toBe(true);
        const resolved = yield* Commands.resolve(request, {
          type: "runtime-request.respond",
          commandId: CommandId.make("decision"),
          threadId,
          requestId: proposal.requestId,
          decision: "accept",
          packageHash: proposal.packageHash,
        }).pipe(
          Effect.provideService(HumanAuthority.ApprovalReviewHumanAuthority, {
            sessionId: AuthSessionId.make("human"),
            subject: "owner",
            method: "browser-session-cookie",
          }),
        );
        request = {
          ...request,
          status: "resolved",
          decision: "accept",
          privilegedCommand: resolved,
        };
        const invoke = Effect.gen(function* () {
          const service = yield* Service.PrivilegedCommandService;
          return yield* service.executeApproved({ threadId, ...proposal });
        });
        yield* invoke.pipe(Effect.provide(layer));
        expect(calls).toHaveLength(1);
        expect(resultWrites).toBe(2);
        expect(calls[0]?.script).toBe("printf approved\\n");
        expect(request?.privilegedCommand?.state).toBe("completed");
        const read = (providerSessionId: string) =>
          Effect.gen(function* () {
            const service = yield* Service.PrivilegedCommandService;
            return yield* service.wait({
              environmentId,
              threadId,
              providerSessionId,
              requestId: proposal.requestId,
            });
          }).pipe(Effect.provide(layer));
        expect((yield* read("session")).state).toBe("completed");
        expect(Exit.isFailure(yield* Effect.exit(read("other")))).toBe(true);
        const second = yield* Effect.exit(invoke.pipe(Effect.provide(layer)));
        expect(Exit.isFailure(second)).toBe(true);
        expect(calls).toHaveLength(1);
        if (!request?.privilegedCommand) throw new Error("missing authority");
        const { claimId: _claimId, result: _result, ...saved } = request.privilegedCommand;
        request = { ...request, privilegedCommand: { ...saved, state: "approved" } };
        failClaim = true;
        const beforeClaims = claimAttempts;
        yield* invoke.pipe(Effect.provide(layer));
        expect(claimAttempts - beforeClaims).toBe(1);
        expect(markerFailures).toBe(2);
        expect(request.privilegedCommand?.state).toBe("unknown");
        expect(calls).toHaveLength(1);
        expect((yield* read("session")).state).toBe("unknown");
        request = { ...request, privilegedCommand: { ...saved, state: "approved" } };
        failClaim = false;
        failAfterClaimCommit = true;
        yield* invoke.pipe(Effect.provide(layer));
        expect(request.privilegedCommand?.state).toBe("unknown");
        expect(calls).toHaveLength(1);
        request = { ...request, privilegedCommand: { ...saved, state: "approved" } };
        failAfterClaimCommit = false;
        failBeforeRunner = true;
        yield* invoke.pipe(Effect.provide(layer));
        expect(calls).toHaveLength(2);
        expect(request.privilegedCommand?.result?.status).toBe("failed");
        expect(lastResultCleanupConfirmed).toBe(true);
      }),
  );
});

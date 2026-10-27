// @effect-diagnostics nodeBuiltinImport:off - IDs are server-generated, not supplied by the agent.
import * as NodeCrypto from "node:crypto";
import {
  ApprovalReviewError,
  CommandId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  PrivilegedCommandBundle,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Schedule from "effect/Schedule";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Executor from "../privilegedCommands/PrivilegedCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as EventSink from "./EventSink.ts";
import { isValidPrivilegedCommand, privilegedCommandHash } from "./PrivilegedCommandPackage.ts";

const decodeBundle = Schema.decodeUnknownEffect(PrivilegedCommandBundle);
const isExecutionError = Schema.is(Executor.PrivilegedCommandExecutionError);

type PrivilegedCommandServiceShape = {
  readonly propose: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly purpose: string;
    readonly script: string;
    readonly shell: "powershell" | "sh";
    readonly cwd: string;
    readonly timeoutMs: number;
  }) => Effect.Effect<
    { readonly requestId: RuntimeRequestId; readonly packageHash: string },
    ApprovalReviewError | Executor.PrivilegedCommandExecutionError
  >;
  readonly executeApproved: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly packageHash: string;
  }) => Effect.Effect<void, ApprovalReviewError>;
  readonly cleanup: (input: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
    readonly shell: "powershell" | "sh";
    readonly identity: import("@t3tools/contracts").PrivilegedCommandRecoveryIdentity;
  }) => Effect.Effect<void, ApprovalReviewError>;
  readonly wait: (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly providerSessionId: string;
    readonly requestId: RuntimeRequestId;
  }) => Effect.Effect<import("@t3tools/contracts").PrivilegedCommandAuthority, ApprovalReviewError>;
  readonly request: (
    input: Parameters<PrivilegedCommandServiceShape["propose"]>[0],
  ) => Effect.Effect<
    {
      readonly requestId: RuntimeRequestId;
      readonly packageHash: string;
      readonly authority: import("@t3tools/contracts").PrivilegedCommandAuthority;
    },
    ApprovalReviewError | Executor.PrivilegedCommandExecutionError
  >;
};
export class PrivilegedCommandService extends Context.Reference<PrivilegedCommandServiceShape>(
  "t3/orchestration-v2/PrivilegedCommandService",
  {
    defaultValue: () => ({
      propose: () => Effect.fail(new ApprovalReviewError({ reason: "disabled" })),
      executeApproved: () => Effect.fail(new ApprovalReviewError({ reason: "disabled" })),
      cleanup: () => Effect.fail(new ApprovalReviewError({ reason: "disabled" })),
      wait: () => Effect.fail(new ApprovalReviewError({ reason: "disabled" })),
      request: () => Effect.fail(new ApprovalReviewError({ reason: "disabled" })),
    }),
  },
) {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const executor = yield* Executor.PrivilegedCommandExecutor;
  const events = yield* EventSink.EventSinkV2;
  const propose = Effect.fn("PrivilegedCommandService.propose")(function* (
    input: Parameters<PrivilegedCommandServiceShape["propose"]>[0],
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    if (environmentId !== input.environmentId)
      return yield* new ApprovalReviewError({ reason: "target-mismatch" });
    const running = yield* store
      .getRunningTurnContext(input.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    if (
      running.run === undefined ||
      running.providerThread?.providerSessionId == null ||
      running.providerTurn === undefined
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (
      !(yield* sessions.ownsMcpCredential({
        providerSessionId: running.providerThread.providerSessionId,
        threadId: input.threadId,
        credentialId: input.providerSessionId,
      }))
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const bundle = yield* decodeBundle(
      {
        environmentId,
        threadId: input.threadId,
        runId: running.run.id,
        providerSessionId: input.providerSessionId,
        purpose: input.purpose,
        script: input.script,
        shell: input.shell,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
      },
      { onExcessProperty: "error" },
    ).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "invalid-action" })));
    if (!isValidPrivilegedCommand(bundle))
      return yield* new ApprovalReviewError({ reason: "invalid-action" });
    const id = NodeCrypto.randomUUID();
    const requestId = RuntimeRequestId.make(`privileged-command:${id}`);
    yield* executor.validate({
      requestId,
      script: bundle.script,
      shell: bundle.shell,
      cwd: bundle.cwd,
      timeoutMs: bundle.timeoutMs,
    });
    const packageHash = privilegedCommandHash(requestId, bundle);
    yield* orchestrator
      .dispatch({
        type: "privileged-command.submit",
        commandId: CommandId.make(`privileged-command-submit:${id}`),
        threadId: input.threadId,
        requestId,
        nodeId: NodeId.make(`privileged-command:${id}`),
        turnItemId: TurnItemId.make(`privileged-command:${id}`),
        authority: { bundle, packageHash, state: "pending" },
      })
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    return { requestId, packageHash };
  });
  const executeApproved = Effect.fn("PrivilegedCommandService.executeApproved")(function* (
    input: Parameters<PrivilegedCommandServiceShape["executeApproved"]>[0],
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    const claimId = NodeCrypto.randomUUID();
    yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const claimed = yield* Effect.exit(
          Effect.gen(function* () {
            const request = yield* store.getRuntimeRequest(input.threadId, input.requestId);
            const authority = request?.privilegedCommand;
            if (
              authority === undefined ||
              authority.bundle.environmentId !== environmentId ||
              authority.packageHash !== input.packageHash ||
              privilegedCommandHash(input.requestId, authority.bundle) !== input.packageHash
            )
              return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
            const recoveryIdentity = yield* executor.captureRecoveryIdentity();
            yield* orchestrator.dispatch({
              type: "privileged-command.claim",
              commandId: CommandId.make(`privileged-command-claim:${claimId}`),
              claimId,
              recoveryIdentity,
              ...input,
            });
            return authority;
          }),
        );
        if (Exit.isFailure(claimed)) {
          const markerId = CommandId.make(`privileged-command-unconfirmed:${claimId}`);
          const marked = yield* restore(
            Effect.gen(function* () {
              const current = yield* store.getRuntimeRequest(input.threadId, input.requestId);
              const authority = current?.privilegedCommand;
              if (
                authority === undefined ||
                authority.packageHash !== input.packageHash ||
                authority.bundle.environmentId !== environmentId ||
                privilegedCommandHash(input.requestId, authority.bundle) !== input.packageHash
              )
                return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
              if (authority.state === "unknown") return true;
              if (
                authority.state !== "approved" &&
                !(authority.state === "claimed" && authority.claimId === claimId)
              )
                return false;
              yield* orchestrator.dispatch({
                type: "privileged-command.unconfirmed",
                commandId: markerId,
                claimId,
                ...input,
              });
              return true;
            }).pipe(Effect.retry(Schedule.spaced("1 second"))),
          );
          if (!marked) return yield* new ApprovalReviewError({ reason: "not-approved" });
          return;
        }
        const authority = claimed.value;
        const { script, shell, cwd, timeoutMs } = authority.bundle;
        const persistId = CommandId.make(`privileged-command-result:${NodeCrypto.randomUUID()}`);
        let interruptedAfterCleanup = false;
        yield* restore(
          Effect.gen(function* () {
            const execution = yield* executor
              .execute({ requestId: input.requestId, script, shell, cwd, timeoutMs })
              .pipe(
                // The executor's interruption finalizer completes only after OS cleanup is proven.
                Effect.onExit((exit) =>
                  Effect.sync(() => {
                    interruptedAfterCleanup =
                      Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
                  }),
                ),
                Effect.catch((error) =>
                  Effect.succeed({
                    status: "failed" as const,
                    exitCode: null,
                    stdout: "",
                    stderr: "Unable to start the privileged command.",
                    ...(isExecutionError(error) && error.cleanupConfirmed === true
                      ? { cleanupConfirmed: true as const }
                      : {}),
                  }),
                ),
              );
            const { cleanupConfirmed, ...result } = execution as typeof execution & {
              readonly cleanupConfirmed?: true;
            };
            // Retry only the same result command. A lost response reuses its receipt; the script is never retried.
            yield* Effect.suspend(() =>
              orchestrator.dispatch({
                type: "privileged-command.result",
                commandId: persistId,
                claimId,
                ...(cleanupConfirmed === true ? { cleanupConfirmed: true } : {}),
                ...input,
                result,
              }),
            ).pipe(Effect.retry(Schedule.spaced("1 second")));
          }),
        ).pipe(
          Effect.onInterrupt(() =>
            interruptedAfterCleanup
              ? orchestrator
                  .dispatch({
                    type: "privileged-command.result",
                    commandId: CommandId.make(
                      `privileged-command-interrupted:${NodeCrypto.randomUUID()}`,
                    ),
                    ...input,
                    claimId,
                    cleanupConfirmed: true,
                    result: {
                      status: "unknown",
                      exitCode: null,
                      stdout: "",
                      stderr: "Execution was interrupted before the result was confirmed.",
                    },
                  })
                  .pipe(Effect.retry(Schedule.spaced("1 second")))
              : Effect.void,
          ),
        );
      }),
    ).pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
  });
  const wait = Effect.fn("PrivilegedCommandService.wait")(function* (
    input: Parameters<PrivilegedCommandServiceShape["wait"]>[0],
  ) {
    const environmentId = yield* identity.getEnvironmentId;
    const sequence = yield* events
      .latestSequence({ threadId: input.threadId })
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const running = yield* store
      .getRunningTurnContext(input.threadId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const current = yield* store
      .getRuntimeRequest(input.threadId, input.requestId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const authority = current?.privilegedCommand;
    if (
      authority === undefined ||
      environmentId !== input.environmentId ||
      authority.bundle.environmentId !== environmentId ||
      authority.bundle.threadId !== input.threadId ||
      authority.bundle.providerSessionId !== input.providerSessionId ||
      running.providerThread?.providerSessionId == null ||
      running.run?.id !== authority.bundle.runId ||
      privilegedCommandHash(input.requestId, authority.bundle) !== authority.packageHash
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    if (
      !(yield* sessions.ownsMcpCredential({
        providerSessionId: running.providerThread.providerSessionId,
        threadId: input.threadId,
        credentialId: input.providerSessionId,
      }))
    )
      return yield* new ApprovalReviewError({ reason: "forbidden" });
    const terminal = (value: typeof authority) =>
      value.state === "rejected" || value.state === "completed" || value.state === "unknown";
    if (terminal(authority)) return authority;
    const event = yield* events.stream({ threadId: input.threadId, afterSequence: sequence }).pipe(
      Stream.filter(
        (entry) =>
          (entry.event.type === "runtime-request.updated" &&
            entry.event.payload.id === input.requestId &&
            entry.event.payload.privilegedCommand !== undefined &&
            terminal(entry.event.payload.privilegedCommand)) ||
          (entry.event.type === "run.updated" &&
            entry.event.payload.id === authority.bundle.runId &&
            !["preparing", "starting", "running", "waiting"].includes(entry.event.payload.status)),
      ),
      Stream.runHead,
      Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })),
    );
    if (Option.isSome(event) && event.value.event.type === "run.updated")
      return yield* new ApprovalReviewError({ reason: "conflict" });
    if (
      Option.isNone(event) ||
      event.value.event.type !== "runtime-request.updated" ||
      event.value.event.payload.privilegedCommand === undefined
    )
      return yield* new ApprovalReviewError({ reason: "storage" });
    const result = event.value.event.payload.privilegedCommand;
    if (
      privilegedCommandHash(input.requestId, result.bundle) !== authority.packageHash ||
      result.packageHash !== authority.packageHash
    )
      return yield* new ApprovalReviewError({ reason: "hash-mismatch" });
    return result;
  });
  const request = Effect.fn("PrivilegedCommandService.request")(function* (
    input: Parameters<PrivilegedCommandServiceShape["propose"]>[0],
  ) {
    const proposal = yield* propose(input);
    const authority = yield* wait({
      environmentId: input.environmentId,
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      requestId: proposal.requestId,
    });
    return { ...proposal, authority };
  });
  const cleanup = Effect.fn("PrivilegedCommandService.cleanup")(function* (
    input: Parameters<PrivilegedCommandServiceShape["cleanup"]>[0],
  ) {
    const outcome = yield* executor
      .cleanup({
        ...input,
        identity: {
          platform: input.identity.platform,
          bootId: input.identity.bootId,
          ...(input.identity.processId === undefined
            ? {}
            : { processId: input.identity.processId }),
          ...(input.identity.processStart === undefined
            ? {}
            : { processStart: input.identity.processStart }),
        },
      })
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    if (outcome.status !== "confirmed")
      return yield* new ApprovalReviewError({ reason: "storage" });
    const current = yield* store
      .getRuntimeResponseContext(input.threadId, input.requestId)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    const authority = current.request?.privilegedCommand;
    if (
      authority?.state === "unknown" &&
      authority.claimId !== undefined &&
      current.item?.type === "approval_request" &&
      current.item.status === "waiting"
    ) {
      yield* orchestrator
        .dispatch({
          type: "privileged-command.cleanup-visible",
          commandId: CommandId.make(`privileged-command-cleanup-visible:${authority.claimId}`),
          threadId: input.threadId,
          requestId: input.requestId,
          packageHash: authority.packageHash,
          claimId: authority.claimId,
        })
        .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "storage" })));
    }
  });
  return PrivilegedCommandService.of({ propose, executeApproved, wait, request, cleanup });
});
export const layer = Layer.effect(PrivilegedCommandService, make);

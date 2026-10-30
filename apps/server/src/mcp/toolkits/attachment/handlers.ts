import {
  ATTACHMENT_UPLOAD_URL_TTL_MS,
  type ChatAttachment,
  MessageId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Upload from "../../../assets/AttachmentUpload.ts";
import * as Claims from "../../../orchestration-v2/AttachmentClaims.ts";
import * as ThreadMessageIntake from "../../../orchestration-v2/ThreadMessageIntake.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  assertLiveCaller,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "../../threadAccess.ts";
import { assertNotLinked } from "../../linkOrigin.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerTransferSender from "../../../peer/PeerTransferSender.ts";
import * as PeerTransferReceiver from "../../../peer/PeerTransferReceiver.ts";
import * as PeerTransferSource from "../../../peer/PeerTransferSource.ts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { AttachmentToolkit } from "./tools.ts";

export function resolveAttachmentReferences(
  requested: ReadonlyArray<ChatAttachment>,
  stored: ReadonlyArray<ChatAttachment>,
) {
  const owned = new Map(stored.map((attachment) => [attachment.id, attachment]));
  return Effect.forEach(requested, (attachment) => {
    const canonical = Claims.attachmentIsPendingUpload(attachment)
      ? attachment
      : owned.get(attachment.id);
    return canonical === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Attachments must be pending uploads or already belong to the target thread.",
          }),
        )
      : Effect.succeed(canonical);
  });
}

/** The 24-hour sweep starts at upload completion, possibly one upload-URL lifetime after issue. */
const UPLOAD_OWNER_TTL_MS = 24 * 60 * 60 * 1000 + ATTACHMENT_UPLOAD_URL_TTL_MS;

const uploadOwner = McpInvocationContext.McpInvocationContext.pipe(
  Effect.map((scope) => scope.thread?.threadId ?? scope.requestNamespace),
);
const isSourceError = Schema.is(PeerTransferSource.PeerTransferSourceError);

export const layer = McpToolAccess.toLayer(
  AttachmentToolkit,
  Effect.sync(() => {
    const uploadOwners = new Map<string, { readonly owner: string; readonly issuedAt: number }>();
    const transferCaller = Effect.fn("AttachmentTransfer.caller")(function* (target: string) {
      const caller = yield* readCaller();
      yield* assertLiveCaller(caller);
      const threadScope = yield* McpInvocationContext.requireThreadScope(
        caller.scope,
        "File transfer",
      );
      yield* assertNotLinked(caller, "use this environment's links");
      yield* assertFullAccess(
        caller,
        "File transfer requires a full-access/default calling agent.",
      );
      if (target === caller.scope.environmentId)
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Choose a different linked environment.",
        });
      const links = yield* PeerLinks.PeerLinks;
      if (!(yield* links.enabled))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Linked environments is disabled.",
        });
      return {
        ...caller,
        transferNamespace: `thread:${encodeURIComponent(threadScope.environmentId)}:${encodeURIComponent(threadScope.thread.threadId)}`,
      };
    });
    const receiverKey = Effect.fn("AttachmentTransfer.receiverKey")(function* (input: {
      readonly target: string;
      readonly requestId: string;
    }) {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (
        scope.client?.linked !== true ||
        scope.linkedEnvironments === false ||
        scope.environmentId !== input.target
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "An authorized link to this exact environment is required.",
        });
      }
      return { ...input, owner: scope.requestNamespace };
    });
    const receiverError = (error: PeerTransferReceiver.PeerTransferReceiverError) =>
      new OrchestratorMcpFailure({
        code: error.reason === "wrong_target" ? "capability_denied" : "invalid_request",
        message: error.message,
      });
    const senderError = (error: PeerTransferSender.PeerTransferSenderError) =>
      new OrchestratorMcpFailure({
        code:
          error.reason === "denied"
            ? "capability_denied"
            : error.reason === "unknown" || error.reason === "peer"
              ? "orchestration_error"
              : "invalid_request",
        message: error.message,
      });
    const sourceError = (error: PeerTransferSource.PeerTransferSourceError) =>
      new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
    return {
      // A pending upload belongs to its caller until a send claims it, so
      // linked callers may stage the uploads their own sends need.
      t3_attachment_prepare_upload: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            const result = yield* Upload.issueAttachmentUploadUrl(input.upload).pipe(
              Effect.mapError(unavailable),
            );
            const now = yield* Clock.currentTimeMillis;
            for (const [id, entry] of uploadOwners) {
              if (now - entry.issuedAt > UPLOAD_OWNER_TTL_MS) uploadOwners.delete(id);
            }
            uploadOwners.set(result.attachmentId, { owner: yield* uploadOwner, issuedAt: now });
            return result;
          }),
        { linkedCallers: "allowed" },
      ),
      t3_attachment_discard: McpToolAccess.writes(
        (input) =>
          Effect.gen(function* () {
            if (uploadOwners.get(input.attachmentId)?.owner !== (yield* uploadOwner)) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Only the caller that prepared a pending upload can discard it.",
              });
            }
            yield* Upload.deletePendingAttachment(input.attachmentId);
            uploadOwners.delete(input.attachmentId);
            return {};
          }),
        { linkedCallers: "allowed" },
      ),
      t3_thread_send_attachments: McpToolAccess.writesThreads(
        (input) => [input.threadId],
        (input) =>
          Effect.gen(function* () {
            const { caller, projection } = yield* readThread(input.threadId, ["messages"]);
            if (projection.thread.archivedAt !== null)
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message: "Unarchive the target thread before sending attachments.",
              });
            const attachments = yield* resolveAttachmentReferences(
              input.attachments,
              projection.messages.flatMap((message) => message.attachments),
            );
            const commandId = yield* newCommandId();
            const messageId = MessageId.make(commandId);
            const result = yield* ThreadMessageIntake.sendToThread({
              projectId: projection.thread.projectId,
              threadId: projection.thread.id,
              commandId,
              messageId,
              ...(caller === undefined ? {} : { senderThreadId: caller.id }),
              text: input.message ?? "",
              attachments,
              mode: "auto",
              createdBy: "agent",
              creationSource: "mcp",
            }).pipe(
              Effect.mapError((error) =>
                error._tag === "AttachmentClaimError"
                  ? new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: error.message,
                    })
                  : unavailable(),
              ),
            );
            return {
              threadId: projection.thread.id,
              messageId,
              runId: result.run.id,
              status: result.run.status,
            };
          }),
      ),
      t3_file_transfer_prepare: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* transferCaller(input.environmentId);
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof transferCaller>>>();
          const runAuthorization = Effect.runPromiseWith(context);
          const source = yield* PeerTransferSource.PeerTransferSource;
          const prepared = yield* source
            .prepare(
              {
                callerNamespace: caller.transferNamespace,
                clientRequestId: input.clientRequestId,
                target: input.environmentId,
              },
              () =>
                runAuthorization(
                  transferCaller(input.environmentId).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  ),
                ),
            )
            .pipe(Effect.mapError(sourceError));
          const self = yield* resolveSelfInvocation();
          return {
            ...prepared,
            executable: self.command,
            ...(self.entrypoint === undefined ? {} : { entrypoint: self.entrypoint }),
          };
        }),
      ),
      t3_file_transfer: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* transferCaller(input.environmentId);
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof transferCaller>>>();
          const source = yield* PeerTransferSource.PeerTransferSource;
          const sender = yield* PeerTransferSender.PeerTransferSender;
          return yield* source
            .withTransfer(
              {
                callerNamespace: caller.transferNamespace,
                clientRequestId: input.clientRequestId,
                target: input.environmentId,
              },
              (staged) =>
                sender
                  .transfer({
                    sourcePath: staged.path,
                    expected: { sizeBytes: staged.sizeBytes, sha256: staged.sha256 },
                    target: input.environmentId,
                    callerNamespace: caller.transferNamespace,
                    authorize: transferCaller(input.environmentId).pipe(
                      Effect.provide(context),
                      Effect.map((current) => current.limits),
                    ),
                    clientRequestId: input.clientRequestId,
                  })
                  .pipe(Effect.mapError(senderError)),
            )
            .pipe(Effect.mapError((error) => (isSourceError(error) ? sourceError(error) : error)));
        }),
      ),
      t3_file_transfer_status: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* transferCaller(input.environmentId);
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof transferCaller>>>();
          const sender = yield* PeerTransferSender.PeerTransferSender;
          return yield* sender
            .status({
              target: input.environmentId,
              callerNamespace: caller.transferNamespace,
              authorize: transferCaller(input.environmentId).pipe(
                Effect.provide(context),
                Effect.map((current) => current.limits),
              ),
              clientRequestId: input.clientRequestId,
            })
            .pipe(Effect.mapError(senderError));
        }),
      ),
      t3_file_transfer_abort: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* transferCaller(input.environmentId);
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof transferCaller>>>();
          const source = yield* PeerTransferSource.PeerTransferSource;
          const sourceKey = {
            callerNamespace: caller.transferNamespace,
            clientRequestId: input.clientRequestId,
            target: input.environmentId,
          };
          const localResult = yield* Effect.result(source.status(sourceKey));
          if (Result.isFailure(localResult) && localResult.failure.reason !== "not_found") {
            return yield* sourceError(localResult.failure);
          }
          const local = Result.isSuccess(localResult) ? localResult.success : undefined;
          if (
            local?.state === "waiting" ||
            local?.state === "receiving" ||
            local?.state === "failed"
          ) {
            yield* source.abort(sourceKey).pipe(Effect.mapError(sourceError));
            return {};
          }
          const sender = yield* PeerTransferSender.PeerTransferSender;
          const request = {
            target: input.environmentId,
            callerNamespace: caller.transferNamespace,
            authorize: transferCaller(input.environmentId).pipe(
              Effect.provide(context),
              Effect.map((current) => current.limits),
            ),
            clientRequestId: input.clientRequestId,
          };
          const abortRemote = Effect.gen(function* () {
            const remote = yield* sender.status(request);
            if (remote.state !== "not_found" && remote.state !== "released") {
              yield* sender.abort(request);
              yield* sender.release(request);
            }
          }).pipe(Effect.mapError(senderError));
          if (local?.state === "interrupted") {
            const removed = yield* Effect.result(source.abort(sourceKey));
            if (Result.isFailure(removed)) {
              if (removed.failure.reason !== "busy" && removed.failure.reason !== "interrupted")
                return yield* sourceError(removed.failure);
            }
          }
          yield* source
            .withRelease(sourceKey, () => abortRemote)
            .pipe(Effect.mapError((error) => (isSourceError(error) ? sourceError(error) : error)));
          return {};
        }),
      ),
      t3_file_transfer_release: McpToolAccess.actsAsCaller((input) =>
        Effect.gen(function* () {
          const caller = yield* transferCaller(input.environmentId);
          const context =
            yield* Effect.context<Effect.Services<ReturnType<typeof transferCaller>>>();
          const sender = yield* PeerTransferSender.PeerTransferSender;
          const source = yield* PeerTransferSource.PeerTransferSource;
          yield* source
            .withRelease(
              {
                callerNamespace: caller.transferNamespace,
                clientRequestId: input.clientRequestId,
                target: input.environmentId,
              },
              () =>
                sender
                  .release({
                    target: input.environmentId,
                    callerNamespace: caller.transferNamespace,
                    authorize: transferCaller(input.environmentId).pipe(
                      Effect.provide(context),
                      Effect.map((current) => current.limits),
                    ),
                    clientRequestId: input.clientRequestId,
                  })
                  .pipe(Effect.mapError(senderError)),
            )
            .pipe(Effect.mapError((error) => (isSourceError(error) ? sourceError(error) : error)));
          return {};
        }),
      ),
      t3_peer_transfer_begin: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver
              .begin({ ...key, sizeBytes: input.sizeBytes, sha256: input.sha256 })
              .pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
      t3_peer_transfer_append: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver
              .append({ ...key, offset: input.offset, base64: input.base64 })
              .pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
      t3_peer_transfer_finish: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver.finish(key).pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
      t3_peer_transfer_status: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver.status(key).pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
      t3_peer_transfer_abort: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver.abort(key).pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
      t3_peer_transfer_release: McpToolAccess.writesEnvironment(
        (input) =>
          Effect.gen(function* () {
            const key = yield* receiverKey(input);
            const receiver = yield* PeerTransferReceiver.PeerTransferReceiver;
            return yield* receiver
              .release({ ...key, destinationUseComplete: input.destinationUseComplete })
              .pipe(Effect.mapError(receiverError));
          }),
        { linkedCallers: "allowed" },
      ),
    };
  }),
);

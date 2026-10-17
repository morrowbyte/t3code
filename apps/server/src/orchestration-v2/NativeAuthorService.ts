import {
  CommandId,
  MessageId,
  NativeAuthorError,
  ThreadId,
  type NativeAuthorCursor,
  NativeAuthorOutput,
  type NativeAuthorRequest,
  type NativeAuthorRootLocator,
  type NativeAuthorSource,
  type NativeAuthorState,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventStore from "./EventStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export class NativeAuthorService extends Context.Service<
  NativeAuthorService,
  {
    readonly execute: (
      request: NativeAuthorRequest,
    ) => Effect.Effect<NativeAuthorState, NativeAuthorError>;
  }
>()("t3/orchestration-v2/NativeAuthorService") {}

const fail = (code: NativeAuthorError["code"]) => new NativeAuthorError({ code });
const transient = () => fail("backend-unavailable");
const encodeOutput = Schema.encodeSync(Schema.fromJsonString(NativeAuthorOutput));
const status = (run: OrchestrationV2Run): NativeAuthorState["status"] => {
  switch (run.status) {
    case "preparing":
    case "queued":
    case "starting":
      return "queued";
    case "interrupted":
    case "rolled_back":
      return "cancelled";
    default:
      return run.status;
  }
};

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const events = yield* EventStore.EventStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const crypto = yield* Crypto.Crypto;
  const lane = yield* KeyedLock.make<string>();

  const digest = (parts: ReadonlyArray<string>) =>
    crypto.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts))).pipe(
      Effect.map((bytes) =>
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      ),
      Effect.mapError(transient),
    );
  const sourceIds = Effect.fn(function* (source: NativeAuthorSource) {
    const conversation = yield* digest([source.engineSessionId, source.conversationId]);
    const turn = yield* digest([source.engineSessionId, source.conversationId, source.turnId]);
    return {
      threadId: ThreadId.make(`native-author:${conversation}`),
      bind: CommandId.make(`native-author:bind:${conversation}`),
      submit: CommandId.make(`native-author:submit:${turn}`),
    };
  });
  const readReceipt = (commandId: CommandId) =>
    receipts.getByCommandId(commandId).pipe(Effect.mapError(transient));
  const readCommand = (commandId: CommandId) =>
    events
      .readByCommandId({ commandId })
      .pipe(Stream.take(128), Stream.runCollect, Effect.mapError(transient));

  const binding = Effect.fn(function* (source: NativeAuthorSource, create: boolean) {
    const ids = yield* sourceIds(source);
    let receipt = yield* readReceipt(ids.bind);
    if (Option.isNone(receipt) && create) {
      const { projectId } = yield* folders.ensureScratchProject.pipe(Effect.mapError(transient));
      const project = yield* projects.getById(projectId).pipe(Effect.mapError(transient));
      const serverSettings = yield* settings.getSettings.pipe(Effect.mapError(transient));
      const modelSelection =
        Option.getOrNull(project)?.defaultModelSelection ?? serverSettings.defaultModelSelection;
      if (!modelSelection) return yield* fail("model-unavailable");
      const folder = yield* folders
        .folderForThread({ projectId, threadId: ids.threadId, text: "Jarvis" })
        .pipe(Effect.mapError(transient));
      if (Option.isNone(folder)) return yield* fail("backend-unavailable");
      yield* threads
        .dispatch({
          type: "thread.create",
          commandId: ids.bind,
          threadId: ids.threadId,
          projectId,
          title: "Jarvis",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: (yield* DispatchModeLimit)?.interactionMode ?? "default",
          branch: null,
          worktreePath: folder.value,
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(() => fail("outcome-unknown")));
      receipt = yield* readReceipt(ids.bind);
    }
    if (Option.isNone(receipt)) return yield* fail("not-submitted");
    if (
      receipt.value.status !== "accepted" ||
      receipt.value.commandType !== "thread.create" ||
      receipt.value.threadId !== ids.threadId
    )
      return yield* fail("receipt-conflict");
    const created = (yield* readCommand(ids.bind)).find(
      (stored) => stored.event.type === "thread.created",
    );
    if (created?.event.type !== "thread.created" || created.event.payload.id !== ids.threadId)
      return yield* fail("receipt-conflict");
    const current = yield* threads
      .getThreadRecords(ids.threadId, [])
      .pipe(Effect.mapError(transient));
    if (
      current.thread.projectId !== created.event.payload.projectId ||
      current.thread.deletedAt !== null ||
      current.thread.lineage.parentThreadId !== null ||
      current.thread.lineage.relationshipToParent !== null ||
      current.thread.lineage.rootThreadId !== ids.threadId
    )
      return yield* fail("receipt-conflict");
    return { ...ids, thread: current.thread };
  });

  const submittedRun = Effect.fn(function* (source: NativeAuthorSource) {
    const bound = yield* binding(source, false);
    const receipt = yield* readReceipt(bound.submit);
    if (Option.isNone(receipt)) return yield* fail("not-submitted");
    if (
      receipt.value.status !== "accepted" ||
      receipt.value.commandType !== "message.dispatch" ||
      receipt.value.threadId !== bound.threadId
    )
      return yield* fail("receipt-conflict");
    const stored = yield* readCommand(bound.submit);
    const created = stored.find((entry) => entry.event.type === "run.created");
    if (created?.event.type !== "run.created") return yield* fail("receipt-conflict");
    const records = yield* threads
      .getThreadRecords(bound.threadId, ["runs"], { runIds: [created.event.payload.id] })
      .pipe(Effect.mapError(transient));
    const runId = created.event.payload.id;
    const run = records.runs.find((candidate) => candidate.id === runId);
    if (!run || run.delegatedTaskId !== undefined) return yield* fail("receipt-conflict");
    const locator: NativeAuthorRootLocator = {
      kind: "native-author-root",
      source,
      environmentId: yield* environment.getEnvironmentId,
      projectId: bound.thread.projectId,
      threadId: bound.threadId,
      runId: run.id,
      rootNodeId: run.rootNodeId,
    };
    return { bound, run, locator, stored };
  });

  const read = Effect.fn(function* (
    source: NativeAuthorSource,
    after: NativeAuthorCursor = { sequence: 0, textOffset: 0 },
  ): Effect.fn.Return<NativeAuthorState, NativeAuthorError> {
    const { bound, run, locator } = yield* submittedRun(source);
    const latest = yield* events
      .latestSequence({ threadId: bound.threadId })
      .pipe(Effect.mapError(transient));
    if (after.sequence > latest)
      return {
        locator,
        status: status(run),
        canonicalStatus: run.status,
        output: [],
        cursor: after,
        hasMore: false,
        gap: "cursor-ahead",
      };
    const rows = yield* events
      .read({
        threadId: bound.threadId,
        afterSequence: after.textOffset > 0 ? Math.max(0, after.sequence - 1) : after.sequence,
        throughSequence: latest,
        limit: 64,
      })
      .pipe(Stream.runCollect, Effect.mapError(transient));
    const output: NativeAuthorOutput[] = [];
    let cursor = after;
    // Includes JSON escaping, per-item metadata and labels. The socket also
    // checks the complete encoded frame, leaving room here for its locator.
    let budget = 48 * 1024;
    for (const row of rows) {
      const event = row.event;
      if (after.textOffset > 0 && cursor === after && row.sequence !== after.sequence)
        return {
          locator,
          status: status(run),
          canonicalStatus: run.status,
          output,
          cursor,
          hasMore: false,
          gap: "history-unavailable",
        };
      if (event.type === "turn-item.updated" && event.payload.runId === run.id) {
        const item = event.payload;
        if (item.type === "assistant_message") {
          const offset = row.sequence === after.sequence ? after.textOffset : 0;
          if (
            offset > item.text.length ||
            (offset > 0 &&
              /[\uD800-\uDBFF]/u.test(item.text.charAt(offset - 1)) &&
              /[\uDC00-\uDFFF]/u.test(item.text.charAt(offset)))
          )
            return {
              locator,
              status: status(run),
              canonicalStatus: run.status,
              output,
              cursor,
              hasMore: false,
              gap: "invalid-text-offset",
            };
          if (!item.text.isWellFormed()) return yield* fail("backend-unavailable");
          const chunk = (length: number) => {
            let end = Math.min(item.text.length, offset + length);
            if (end < item.text.length && /[\uD800-\uDBFF]/u.test(item.text.charAt(end - 1))) end--;
            return item.text.slice(offset, end);
          };
          const record = (text: string): NativeAuthorOutput => ({
            sequence: row.sequence,
            itemId: item.id,
            kind: "assistant-text",
            text,
            textOffset: offset,
            totalTextLength: item.text.length,
            streaming: item.streaming,
          });
          let length = Math.min(8_192, item.text.length - offset);
          const bytes = (text: string) =>
            new TextEncoder().encode(encodeOutput(record(text))).length + 1;
          if (bytes(chunk(length)) > budget) {
            let low = 0;
            let high = length;
            while (low < high) {
              const mid = Math.ceil((low + high) / 2);
              if (bytes(chunk(mid)) <= budget) low = mid;
              else high = mid - 1;
            }
            length = low;
          }
          const text = chunk(length);
          if ((text.length === 0 && offset < item.text.length) || bytes(text) > budget) break;
          output.push(record(text));
          budget -= bytes(text);
          if (offset + text.length < item.text.length)
            return {
              locator,
              status: status(run),
              canonicalStatus: run.status,
              output,
              cursor: { sequence: row.sequence, textOffset: offset + text.length },
              hasMore: true,
              gap: null,
            };
        } else if (item.type !== "user_message" && item.type !== "reasoning") {
          // Only schema-owned labels cross the speech boundary; arguments, approval prompts,
          // secrets and command output remain in the authenticated normal conversation.
          const label: NativeAuthorOutput = {
            sequence: row.sequence,
            itemId: item.id,
            kind: "phase",
            text: item.type,
            textOffset: 0,
            totalTextLength: item.type.length,
            streaming: item.status === "running",
          };
          const bytes = new TextEncoder().encode(encodeOutput(label)).length + 1;
          if (bytes > budget) break;
          output.push(label);
          budget -= bytes;
        }
      }
      cursor = { sequence: row.sequence, textOffset: 0 };
      if (budget <= 0) break;
    }
    const gap = after.textOffset > 0 && cursor === after ? "history-unavailable" : null;
    return {
      locator,
      status: status(run),
      canonicalStatus: run.status,
      output,
      cursor,
      hasMore: gap === null && cursor.sequence < latest,
      gap,
    };
  });

  const execute = Effect.fn("NativeAuthorService.execute")(function* (
    request: NativeAuthorRequest,
  ) {
    const callerLimit = yield* DispatchModeLimit;
    const ids = yield* sourceIds(request.source);
    return yield* lane
      .withLock(
        ids.threadId,
        Effect.gen(function* () {
          if (request.operation === "read" || request.operation === "open-results")
            return yield* read(
              request.source,
              request.operation === "read" ? request.after : undefined,
            );
          if (request.operation === "submit") {
            const bound = yield* binding(request.source, true);
            const messageId = MessageId.make(
              `native-author:${yield* digest([request.source.engineSessionId, request.source.conversationId, request.source.turnId, request.requestId])}`,
            );
            const receipt = yield* readReceipt(bound.submit);
            if (Option.isSome(receipt)) {
              const stored = yield* readCommand(bound.submit);
              const message = stored.find((entry) => entry.event.type === "message.updated");
              if (
                message?.event.type !== "message.updated" ||
                message.event.payload.id !== messageId ||
                message.event.payload.text !== request.text
              )
                return yield* fail("receipt-conflict");
            } else {
              yield* threads
                .dispatch({
                  type: "message.dispatch",
                  commandId: bound.submit,
                  threadId: bound.threadId,
                  messageId,
                  text: request.text,
                  attachments: [],
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: "user",
                  creationSource: "server",
                })
                .pipe(Effect.mapError(() => fail("outcome-unknown")));
            }
            return yield* read(request.source);
          }
          const { bound, run } = yield* submittedRun(request.source);
          if (request.expectedRunId !== run.id) return yield* fail("stale-run");
          const control = CommandId.make(
            `native-author:control:${yield* digest([request.source.engineSessionId, request.source.conversationId, request.source.turnId, request.requestId])}`,
          );
          const receipt = yield* readReceipt(control);
          if (Option.isSome(receipt)) {
            if (receipt.value.threadId !== bound.threadId || receipt.value.status !== "accepted")
              return yield* fail("receipt-conflict");
            const stored = yield* readCommand(control);
            if (request.operation === "steer") {
              const message = stored.find((row) => row.event.type === "message.updated");
              if (
                receipt.value.commandType !== "message.dispatch" ||
                message?.event.type !== "message.updated" ||
                message.event.payload.text !== request.text ||
                message.event.payload.runId !== run.id
              )
                return yield* fail("receipt-conflict");
            } else if (
              receipt.value.commandType !== "run.interrupt" &&
              receipt.value.commandType !== "queued-run.cancel"
            )
              return yield* fail("receipt-conflict");
          } else {
            if (request.operation === "steer") {
              if (run.status !== "running") return yield* fail("stale-run");
              yield* threads
                .dispatch({
                  type: "message.dispatch",
                  commandId: control,
                  threadId: bound.threadId,
                  messageId: MessageId.make(control),
                  text: request.text,
                  attachments: [],
                  dispatchMode: { type: "steer_active", targetRunId: run.id, onInactive: "reject" },
                  createdBy: "user",
                  creationSource: "server",
                })
                .pipe(Effect.mapError(() => fail("outcome-unknown")));
            } else {
              if (!["preparing", "queued", "starting", "running", "waiting"].includes(run.status))
                return yield* fail("stale-run");
              yield* threads
                .dispatch(
                  run.status === "queued"
                    ? {
                        type: "queued-run.cancel",
                        commandId: control,
                        threadId: bound.threadId,
                        runId: run.id,
                      }
                    : {
                        type: "run.interrupt",
                        commandId: control,
                        threadId: bound.threadId,
                        runId: run.id,
                        holdQueue: false,
                      },
                )
                .pipe(Effect.mapError(() => fail("outcome-unknown")));
            }
          }
          return yield* read(request.source);
        }),
      )
      .pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "approval-required",
          interactionMode: callerLimit?.interactionMode ?? "default",
        }),
      );
  });
  return NativeAuthorService.of({ execute });
});

export const layer = Layer.effect(NativeAuthorService, make);

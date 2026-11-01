import type * as CodexClient from "effect-codex-app-server/client";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as CodexError from "effect-codex-app-server/errors";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";
import {
  assertCodexVoiceMcpIsolation,
  assertCodexVoiceThreadIsolation,
  codexVoiceIsolationConfig,
} from "./CodexAdapterV2VoiceIsolation.ts";

const decodeStarted = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({ id: Schema.String }),
    model: Schema.String,
    reasoningEffort: Schema.optionalKey(Schema.NullOr(Schema.String)),
    serviceTier: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const decodeTurn = Schema.decodeUnknownEffect(
  Schema.Struct({ turn: Schema.Struct({ id: Schema.String }) }),
);
const decodeThreadId = Schema.decodeUnknownEffect(
  Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) }),
);
const stoppedTool = {
  success: false,
  contentItems: [{ type: "inputText" as const, text: "Evaluation tool call was not accepted." }],
};

export const runCodexEvaluation = Effect.fn("CodexAdapterV2.runEvaluation")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  input: ProviderAdapter.ProviderAdapterV2EvaluationInput & { readonly cwd: string },
) {
  const refused = new ProviderAdapter.ProviderAdapterEvaluationError({
    driver: ProviderDriverKind.make("codex"),
  });
  const answer = yield* Deferred.make<
    ProviderAdapter.ProviderAdapterV2EvaluationResult,
    ProviderAdapter.ProviderAdapterV2Error
  >();
  const stopped = yield* Deferred.make<void>();
  const turnStarted = yield* Deferred.make<string>();
  const pending = new Set<Deferred.Deferred<void>>();
  const calls = new Set<string>();
  const tools = new Set(input.tools.map((tool) => tool.name));
  const effort = getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort");
  const serviceTier = getCodexServiceTierOptionValue(input.modelSelection);
  let nativeThreadId: string | undefined;
  let nativeTurnId: string | undefined;
  let observedTurnId: string | undefined;
  let finalText: string | undefined;
  let visibleText = "";
  let completed = false;
  let toolFailure: ProviderAdapter.ProviderAdapterV2Error | undefined;
  const matches = (threadId: string, turnId: string) => {
    if (threadId !== nativeThreadId) return false;
    const expected = nativeTurnId ?? observedTurnId;
    if (expected !== undefined && expected !== turnId) return false;
    observedTurnId = turnId;
    return true;
  };
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(stopped, undefined);
      yield* Effect.forEach(pending, (done) => Deferred.await(done), { discard: true });
      if (!nativeThreadId) return;
      if (!completed && (nativeTurnId ?? observedTurnId)) {
        yield* client.raw
          .request("turn/interrupt", {
            threadId: nativeThreadId,
            turnId: nativeTurnId ?? observedTurnId,
          })
          .pipe(Effect.timeout("1 second"), Effect.ignore);
      }
      yield* client.raw
        .request("thread/archive", { threadId: nativeThreadId })
        .pipe(Effect.timeout("1 second"), Effect.ignore);
      yield* client.raw
        .request("thread/unsubscribe", { threadId: nativeThreadId })
        .pipe(Effect.timeout("1 second"), Effect.ignore);
    }),
  );
  yield* client.handleServerRequest("item/tool/call", (payload) =>
    Effect.gen(function* () {
      if (payload.threadId !== nativeThreadId || completed) return stoppedTool;
      const turnId = yield* Deferred.await(turnStarted).pipe(
        Effect.raceFirst(Deferred.await(stopped).pipe(Effect.as(undefined))),
      );
      if (turnId !== payload.turnId || completed) return stoppedTool;
      if (!tools.has(payload.tool) || calls.has(payload.callId)) {
        toolFailure = refused;
        return stoppedTool;
      }
      calls.add(payload.callId);
      const done = yield* Deferred.make<void>();
      pending.add(done);
      return yield* Effect.suspend(() =>
        input.onToolCall({
          callId: payload.callId,
          name: payload.tool,
          ...(payload.namespace != null ? { namespace: payload.namespace } : {}),
          arguments: payload.arguments,
          visibleText,
        }),
      ).pipe(
        Effect.catch((cause) => {
          toolFailure = cause;
          return Effect.succeed(stoppedTool);
        }),
        Effect.raceFirst(Deferred.await(stopped).pipe(Effect.as(stoppedTool))),
        Effect.ensuring(
          Effect.sync(() => pending.delete(done)).pipe(
            Effect.andThen(Deferred.succeed(done, undefined)),
          ),
        ),
      );
    }),
  );
  yield* client.handleUnknownServerRequest((method) =>
    Deferred.fail(answer, refused).pipe(
      Effect.andThen(Effect.fail(CodexError.CodexAppServerRequestError.methodNotFound(method))),
    ),
  );
  yield* client.handleServerNotification("item/completed", (payload) => {
    if (!matches(payload.threadId, payload.turnId)) return Effect.void;
    const item = payload.item;
    if (item.type === "agentMessage") {
      if (item.delivery === "async" || item.questions?.length)
        return Deferred.fail(answer, refused).pipe(Effect.asVoid);
      visibleText += `${visibleText ? "\n\n" : ""}${item.text}`;
      if (item.phase !== "commentary") finalText = item.text;
    } else if (item.type === "dynamicToolCall") {
      if (!tools.has(item.tool)) return Deferred.fail(answer, refused).pipe(Effect.asVoid);
    } else if (!["userMessage", "reasoning"].includes(item.type)) {
      return Deferred.fail(answer, refused).pipe(Effect.asVoid);
    }
    return Effect.void;
  });
  yield* client.handleServerNotification("error", (payload) =>
    matches(payload.threadId, payload.turnId) && !payload.willRetry
      ? Deferred.fail(answer, refused).pipe(Effect.asVoid)
      : Effect.void,
  );
  yield* client.handleServerNotification("thread/closed", (payload) =>
    payload.threadId === nativeThreadId
      ? Deferred.fail(answer, refused).pipe(Effect.asVoid)
      : Effect.void,
  );
  yield* client.handleServerNotification("turn/completed", (payload) => {
    if (!matches(payload.threadId, payload.turn.id)) return Effect.void;
    completed = true;
    return Deferred.succeed(stopped, undefined).pipe(
      Effect.andThen(
        payload.turn.status !== "completed" ||
          finalText === undefined ||
          pending.size > 0 ||
          toolFailure
          ? Deferred.fail(answer, toolFailure ?? refused)
          : Deferred.succeed(answer, { text: finalText, visibleText }),
      ),
      Effect.asVoid,
    );
  });
  return yield* Effect.gen(function* () {
    yield* client.raw.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    const effective = yield* client.raw.request("config/read", {
      cwd: input.cwd,
      includeLayers: false,
    });
    const config = yield* Effect.try(() => codexVoiceIsolationConfig(effective, false));
    const started = yield* client.raw.request("thread/start", {
      model: input.modelSelection.model,
      ...(serviceTier ? { serviceTier } : {}),
      cwd: input.cwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      runtimeWorkspaceRoots: [],
      ephemeral: true,
      dynamicTools: input.tools.map((tool) => ({ type: "function", ...tool })),
      baseInstructions: input.instructions,
      config: { ...config, ...(effort ? { model_reasoning_effort: effort } : {}) },
    });
    nativeThreadId = (yield* decodeThreadId(started)).thread.id;
    const selected = yield* decodeStarted(started);
    yield* Effect.try(() => assertCodexVoiceThreadIsolation(started, true));
    if (
      selected.model !== input.modelSelection.model ||
      (effort !== undefined && selected.reasoningEffort !== effort) ||
      (serviceTier !== undefined && selected.serviceTier !== serviceTier)
    )
      return yield* refused;
    const inventory = yield* client.raw.request("mcpServerStatus/list", {
      threadId: nativeThreadId,
      limit: 256,
      detail: "full",
    });
    yield* Effect.try(() => assertCodexVoiceMcpIsolation(inventory));
    const turn = yield* client.raw.request("turn/start", {
      threadId: nativeThreadId,
      model: input.modelSelection.model,
      ...(effort ? { effort } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: input.input, text_elements: [] }],
    });
    nativeTurnId = (yield* decodeTurn(turn)).turn.id;
    if (observedTurnId !== undefined && observedTurnId !== nativeTurnId) return yield* refused;
    yield* Deferred.succeed(turnStarted, nativeTurnId);
    return yield* Deferred.await(answer);
  }).pipe(
    Effect.raceFirst(Deferred.await(answer).pipe(Effect.andThen(Effect.never))),
    Effect.raceFirst(client.awaitTermination),
  );
});

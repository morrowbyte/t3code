import {
  AgentAvatarError,
  AgentAvatarState,
  type AgentAvatarKey,
  type AgentAvatarGenerateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  createAttachmentId,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as CodexAvatarGenerator from "./CodexAvatarGenerator.ts";

export class AgentAvatarService extends Context.Service<
  AgentAvatarService,
  {
    readonly read: (key: AgentAvatarKey) => Effect.Effect<AgentAvatarState, AgentAvatarError>;
    readonly generate: (
      input: AgentAvatarGenerateInput,
    ) => Effect.Effect<AgentAvatarState, AgentAvatarError>;
    readonly cancel: (key: AgentAvatarKey) => Effect.Effect<AgentAvatarState, AgentAvatarError>;
  }
>()("t3/agent-avatar/AgentAvatarService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const generator = yield* CodexAvatarGenerator.CodexAvatarGenerator;
  const scope = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  const root = path.join(config.stateDir, "agent-avatars");
  const states = new Map<string, AgentAvatarState>();
  const jobs = new Map<string, Fiber.Fiber<void>>();
  const keyId = (key: AgentAvatarKey) => JSON.stringify([key.threadId, key.theme]);
  const manifestPath = (key: AgentAvatarKey) =>
    path.join(root, `${createDeterministicAttachmentId(key.threadId, key.theme)}.json`);
  const missing = (key: AgentAvatarKey): AgentAvatarState => ({
    ...key,
    status: "missing",
    attachmentId: null,
    mimeType: null,
    error: null,
    updatedAt: null,
  });
  const save = Effect.fn("AgentAvatarService.save")(
    function* (state: AgentAvatarState) {
      yield* fs.makeDirectory(root, { recursive: true });
      const target = manifestPath(state);
      const temporary = `${target}.tmp`;
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AgentAvatarState))(state);
      yield* fs.writeFileString(temporary, encoded);
      yield* fs.rename(temporary, target);
      states.set(keyId(state), state);
      return state;
    },
    Effect.mapError(
      () => new AgentAvatarError({ message: "The agent image state could not be saved." }),
    ),
  );
  const load = Effect.fn("AgentAvatarService.load")(
    function* (key: AgentAvatarKey) {
      const cached = states.get(keyId(key));
      if (cached) return cached;
      const file = manifestPath(key);
      if (!(yield* fs.exists(file))) return missing(key);
      const state = yield* fs
        .readFileString(file)
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(AgentAvatarState))));
      if (state.threadId !== key.threadId || state.theme !== key.theme)
        return yield* new AgentAvatarError({
          message: "The agent image manifest belongs to another agent.",
        });
      if (state.status === "generating")
        return yield* save({
          ...state,
          status: "failed",
          error: "Image generation was interrupted by a server restart. Generate again to retry.",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
      states.set(keyId(key), state);
      return state;
    },
    Effect.mapError((cause) =>
      Schema.is(AgentAvatarError)(cause)
        ? cause
        : new AgentAvatarError({ message: "The agent image state could not be read." }),
    ),
  );
  const checkThread = Effect.fn("AgentAvatarService.checkThread")(
    function* (key: AgentAvatarKey) {
      const thread = yield* orchestrator.getThreadShell(key.threadId);
      if (!thread)
        return yield* new AgentAvatarError({
          message: "The agent thread does not exist on this server.",
        });
      return thread;
    },
    Effect.mapError((cause) =>
      Schema.is(AgentAvatarError)(cause)
        ? cause
        : new AgentAvatarError({ message: "The agent thread could not be read." }),
    ),
  );
  const read = Effect.fn("AgentAvatarService.read")(function* (key: AgentAvatarKey) {
    yield* checkThread(key);
    return yield* gate.withPermits(1)(load(key));
  });
  const generate = Effect.fn("AgentAvatarService.generate")(function* (
    input: AgentAvatarGenerateInput,
  ) {
    const thread = yield* checkThread(input);
    return yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const key: AgentAvatarKey = { threadId: input.threadId, theme: input.theme };
        const id = keyId(key);
        const previous = yield* load(key);
        if (jobs.has(id) || (previous.status === "ready" && !input.regenerate)) return previous;
        const state = yield* save({
          ...previous,
          status: "generating",
          error: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const work = Effect.gen(function* () {
          const image = yield* generator.generate(input, thread.modelSelection);
          const attachmentId = createAttachmentId(
            key.threadId,
            image.mimeType === "image/png"
              ? "png"
              : image.mimeType === "image/jpeg"
                ? "jpg"
                : "webp",
          );
          if (!attachmentId)
            return yield* new AgentAvatarError({
              message: "The agent image attachment could not be named.",
            });
          const destination = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment: {
              type: "image",
              id: attachmentId,
              name: "agent-avatar",
              mimeType: image.mimeType,
              sizeBytes: image.bytes.byteLength,
            },
          });
          if (!destination)
            return yield* new AgentAvatarError({
              message: "The agent image attachment path is invalid.",
            });
          yield* gate.withPermits(1)(
            Effect.gen(function* () {
              if (states.get(id) !== state) return;
              yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
              yield* fs.writeFile(`${destination}.part`, image.bytes);
              yield* fs.rename(`${destination}.part`, destination);
              yield* save({
                ...state,
                status: "ready",
                attachmentId,
                mimeType: image.mimeType,
                updatedAt: DateTime.formatIso(yield* DateTime.now),
              });
              jobs.delete(id);
            }),
          );
        }).pipe(
          Effect.catchCause((cause) =>
            gate
              .withPermits(1)(
                Effect.gen(function* () {
                  if (states.get(id) !== state) return;
                  // Persist a stable public error; provider payloads and credentials never enter manifests.
                  const failure = cause.reasons.find((reason) => reason._tag === "Fail");
                  const message =
                    failure?._tag === "Fail" && Schema.is(AgentAvatarError)(failure.error)
                      ? failure.error.message
                      : "Agent image generation failed. Generate again to retry.";
                  yield* save({
                    ...state,
                    status: "failed",
                    error: message,
                    updatedAt: DateTime.formatIso(yield* DateTime.now),
                  });
                  jobs.delete(id);
                }),
              )
              .pipe(Effect.ignore),
          ),
        );
        const fiber = yield* work.pipe(Effect.interruptible, Effect.forkIn(scope));
        jobs.set(id, fiber);
        return state;
      }).pipe(Effect.uninterruptible),
    );
  });
  const cancel = Effect.fn("AgentAvatarService.cancel")(function* (key: AgentAvatarKey) {
    yield* checkThread(key);
    return yield* gate.withPermits(1)(
      Effect.gen(function* () {
        const id = keyId(key);
        const state = yield* load(key);
        const fiber = jobs.get(id);
        if (!fiber) return state;
        const cancelled = yield* save({
          ...state,
          status: "cancelled",
          error: null,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        jobs.delete(id);
        fiber.interruptUnsafe();
        return cancelled;
      }).pipe(Effect.uninterruptible),
    );
  });
  return AgentAvatarService.of({ read, generate, cancel });
});

export const layer = Layer.effect(AgentAvatarService, make);

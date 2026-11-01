import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  DEFAULT_BOAT_DEFAULTS,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type BoatState,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CrewHostFrame,
  decodeCrewFrame,
  encodeCrewFrame,
} from "../../../../evals/shared/crewProviderProtocol.ts";
import * as BoatService from "../boat/BoatService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderEvalBoat from "./ProviderEvalBoat.ts";
import * as ProviderEvalSession from "./ProviderEvalSession.ts";

const owner: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("boat-test-environment"),
  requestNamespace: "boat-test",
  issuedAt: 0,
  thread: {
    threadId: ThreadId.make("boat-test-thread"),
    providerSessionId: "test-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
};
const input: ProviderEvalBoat.ProviderEvalBoatInput = {
  projectId: ProjectId.make("boat-project"),
  requestId: "boat-request",
  hostId: "test-ssh-host",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  caseIds: ["BOAT-02"],
  samples: 1,
};
const boatState: BoatState = {
  configured: true,
  account: null,
  defaults: DEFAULT_BOAT_DEFAULTS,
  projects: {},
  instances: [
    {
      projectId: input.projectId,
      requestId: input.requestId,
      sandboxId: "test-sandbox",
      state: "idle",
      savedSnapshot: null,
      leases: [],
      stoppedAt: null,
      threadId: null,
      previewTabId: null,
      size: "default",
      createdAt: "2026-11-01",
      expiresAt: "2026-11-02",
      costUsd: 0,
      snapshot: "fixture",
      processId: null,
      deletionOperationId: null,
      output: "",
      previewUrl: null,
    },
  ],
};

const makeHarness = (
  mode: "complete" | "foreign" | "interrupt" | "wrong-host" | "exit-start" | "exit-respond",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "crew-boat-test-" });
    const stdout = yield* Queue.unbounded<Uint8Array>();
    const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const received = yield* Deferred.make<void>();
    const providerWaiting = yield* Deferred.make<void>();
    const cleaned = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const commands: Array<ChildProcess.StandardCommand> = [];
    const replies: Array<typeof CrewHostFrame.Type> = [];
    const send = (frame: Parameters<typeof encodeCrewFrame>[0]) =>
      Queue.offer(stdout, new TextEncoder().encode(encodeCrewFrame(frame)));
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command))
          return yield* Effect.die("Expected one SSH command");
        commands.push(command);
        yield* Effect.addFinalizer(() =>
          Queue.end(stdout).pipe(
            Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143))),
            Effect.andThen(Deferred.succeed(stopped, undefined)),
          ),
        );
        yield* send({ type: "ready", version: 1 });
        yield* send({
          type: "request",
          id: "request-1",
          request: {
            action: "start",
            modelSelection: { instanceId: ProviderInstanceId.make("untrusted"), model: "ignored" },
            instructions: "Use the fixture tool.",
            input: "Read it.",
            tools: [{ name: "exec", description: "Fixture exec", inputSchema: { type: "object" } }],
          },
        });
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: Deferred.await(exit),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Effect.gen(function* () {
              const frame = yield* decodeCrewFrame(
                CrewHostFrame,
                new TextDecoder().decode(bytes).trimEnd(),
              );
              replies.push(frame);
              if (frame.type !== "response") return;
              if (frame.response.type === "tool_call") {
                yield* Deferred.succeed(received, undefined);
                if (mode === "foreign") {
                  yield* Queue.offer(
                    stdout,
                    new TextEncoder().encode("AUTH_REQUIRED use a token\n"),
                  );
                } else if (mode === "complete" || mode === "exit-respond") {
                  yield* send({
                    type: "request",
                    id: "request-2",
                    request: {
                      action: "respond",
                      evaluationId: frame.response.evaluationId,
                      callId: frame.response.callId,
                      contentItems: [{ type: "inputText", text: "fixture result" }],
                      success: true,
                    },
                  });
                }
              } else if (frame.response.type === "complete") {
                yield* send({
                  type: "result",
                  summary: {
                    cases: 1,
                    samples: 1,
                    passed: 1,
                    failed: 0,
                    errors: 0,
                    usage: "unknown",
                  },
                });
                yield* Queue.end(stdout);
                yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
              }
            }).pipe(Effect.orDie),
          ),
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const registry = ProviderAdapterRegistry.layerFromAdapters([
      {
        instanceId: ProviderInstanceId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.die("unused"),
        planSelectionTransition: () => Effect.die("unused"),
        openSession: () => Effect.die("unused"),
        evaluate: (request) =>
          Effect.gen(function* () {
            expect(request.modelSelection).toEqual(input.modelSelection);
            if (mode === "exit-start") {
              yield* Deferred.succeed(providerWaiting, undefined);
              return yield* Effect.never;
            }
            const response = yield* request.onToolCall({
              callId: "call-1",
              name: "exec",
              arguments: { code: "fixture" },
            });
            expect(response).toEqual({
              contentItems: [{ type: "inputText", text: "fixture result" }],
              success: true,
            });
            if (mode === "exit-respond") {
              yield* Deferred.succeed(providerWaiting, undefined);
              return yield* Effect.never;
            }
            return { text: "Read the fixture." };
          }).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined))),
      },
    ]);
    const layer = ProviderEvalBoat.layer.pipe(
      Layer.provide([
        ProviderEvalSession.layer.pipe(Layer.provide(registry)),
        Layer.mock(BoatService.BoatService)({ read: () => Effect.succeed(boatState) }),
        ServerSettings.ServerSettingsService.layerTest({
          deviceHosts: [
            {
              id: input.hostId,
              kind: "ssh",
              label: mode === "wrong-host" ? "other" : "boat-test-sandbox",
              target: "user@registered-boat",
              port: 2222,
              identityFile: "/private/registered-key",
            },
          ],
        }),
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HostProcess.HomeDirectory, home),
      ]),
    );
    const disconnect = Queue.end(stdout).pipe(
      Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(255))),
    );
    return {
      layer,
      received,
      providerWaiting,
      disconnect,
      cleaned,
      stopped,
      replies,
      commands,
      fs,
    };
  });

it.effect("round-trips SSH request IDs through the native session tool callback", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("complete");
    yield* Effect.gen(function* () {
      const service = yield* ProviderEvalBoat.ProviderEvalBoat;
      const result = yield* service.run(input);
      expect(result.exitCode).toBe(0);
      expect(result.summary).toEqual({
        cases: 1,
        samples: 1,
        passed: 1,
        failed: 0,
        errors: 0,
        usage: "unknown",
      });
      expect(h.replies.map((frame) => frame.id)).toEqual(["request-1", "request-2"]);
      expect(JSON.stringify(result)).not.toContain("fixture result");
      expect(yield* h.fs.readFileString(result.stdoutPath)).toContain('"id":"request-2"');
      const args = h.commands[0]!.args;
      expect(args).toContain("StrictHostKeyChecking=yes");
      expect(args).toContain("/private/registered-key");
      expect(args).toContain("2222");
      expect(args.join(" ")).not.toContain("--env-file");
    }).pipe(
      Effect.provide(h.layer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

it.effect("rejects a foreign SSH protocol and closes its pending native evaluation", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("foreign");
    yield* Effect.gen(function* () {
      const service = yield* ProviderEvalBoat.ProviderEvalBoat;
      const error = yield* service.run(input).pipe(Effect.flip);
      expect(error.code).toBe("protocol");
      expect(error.message).not.toContain("AUTH_REQUIRED");
      expect(yield* Deferred.isDone(h.cleaned)).toBe(true);
      expect(yield* Deferred.isDone(h.stopped)).toBe(true);
      expect(h.commands).toHaveLength(1);
    }).pipe(
      Effect.provide(h.layer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

it.effect.each(["interrupt", "exit-start", "exit-respond"] as const)(
  "cancels the captured process scope and its evaluation on %s",
  (mode) =>
    Effect.gen(function* () {
      const h = yield* makeHarness(mode);
      yield* Effect.gen(function* () {
        const service = yield* ProviderEvalBoat.ProviderEvalBoat;
        const fiber = yield* service.run(input).pipe(Effect.flip, Effect.forkChild);
        if (mode === "interrupt") {
          yield* Deferred.await(h.received);
          yield* Fiber.interrupt(fiber);
        } else {
          yield* Deferred.await(h.providerWaiting);
          yield* h.disconnect;
          expect((yield* Fiber.join(fiber)).code).toBe("ssh");
        }
        expect(yield* Deferred.isDone(h.cleaned)).toBe(true);
        expect(yield* Deferred.isDone(h.stopped)).toBe(true);
        expect(h.commands).toHaveLength(1);
      }).pipe(
        Effect.provide(h.layer),
        Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
      );
    }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

it.effect("refuses an unrelated registered SSH host before spawning", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("wrong-host");
    yield* Effect.gen(function* () {
      const service = yield* ProviderEvalBoat.ProviderEvalBoat;
      expect((yield* service.run(input).pipe(Effect.flip)).code).toBe("host_mismatch");
      expect(h.commands).toHaveLength(0);
    }).pipe(
      Effect.provide(h.layer),
      Effect.provideService(McpInvocationContext.McpInvocationContext, owner),
    );
  }).pipe(Effect.scoped, Effect.provide([NodeServices.layer, NodeCrypto.layer])),
);

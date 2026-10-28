import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, VoiceIntakeDecision } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import { runCodexVoiceIntakeDecision } from "./CodexAdapterV2VoiceIntake.ts";

const Frame = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const decodeFrame = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStart = Schema.decodeUnknownEffect(
  Schema.Struct({
    environments: Schema.Array(Schema.Unknown),
    runtimeWorkspaceRoots: Schema.Array(Schema.Unknown),
    config: Schema.Struct({
      mcp_servers: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
    }),
  }),
);
const decodeDecision = Schema.decodeUnknownEffect(VoiceIntakeDecision);
function assertStrictObjects(value: unknown) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const child of value) assertStrictObjects(child);
    return;
  }
  const object = value as Record<string, unknown>;
  if (object.type === "object") {
    assert.equal(object.additionalProperties, false);
    assert.deepEqual(
      [...(object.required as string[])].sort(),
      Object.keys(object.properties as object).sort(),
    );
  }
  for (const child of Object.values(object)) assertStrictObjects(child);
}
const snapshot = {
  requestId: "lease:1:1",
  leaseId: "lease",
  generation: 1,
  version: 1,
  provisionalReadOnlyAvailable: true,
  defaultProjectId: "current-project",
  projects: [],
  segments: [{ stopId: null, id: "segment", revision: 1, text: "Research runners.", final: false }],
  intents: [],
};
const decision = {
  requestId: snapshot.requestId,
  actions: [{ type: "defer" as const, reason: "No new work." }],
};

it.effect.each(["json", "mutation", "clock", "async", "mcp", "shell"] as const)(
  "isolates the actual protocol client from public delivery and execution (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const inputSnapshot =
        scenario === "mutation"
          ? {
              ...snapshot,
              previewContext: "button#selected",
              segments: [
                { ...snapshot.segments[0]!, text: "Change this selected button to green." },
              ],
            }
          : snapshot;
      const expectedDecision =
        scenario === "mutation"
          ? {
              requestId: snapshot.requestId,
              actions: [
                {
                  type: "new" as const,
                  projectId: null,
                  request: "Make the selected button green.",
                  readOnly: false,
                  sources: [
                    {
                      segmentId: "segment",
                      revision: 1,
                      quote: "Change this selected button to green.",
                    },
                  ],
                },
              ],
            }
          : decision;
      const inbound = yield* Queue.unbounded<Uint8Array>();
      const methods: string[] = [];
      const responses: unknown[] = [];
      const emit = (frame: unknown) =>
        Queue.offer(inbound, new TextEncoder().encode(`${encode(frame)}\n`));
      const client = yield* CodexClient.make(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(inbound),
          stderr: () => Sink.drain,
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                const frame = decodeFrame(
                  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                );
                if (!frame.method) {
                  responses.push(frame);
                  return;
                }
                methods.push(frame.method);
                const reply = (result: unknown) => emit({ id: frame.id, result });
                switch (frame.method) {
                  case "initialize":
                    yield* reply({ userAgent: "fixture" });
                    break;
                  case "initialized":
                    break;
                  case "config/read":
                    yield* reply({ config: { mcp_servers: { inherited: { enabled: true } } } });
                    break;
                  case "thread/start": {
                    const params = yield* decodeStart(frame.params);
                    assert.deepEqual(params.environments, []);
                    assert.deepEqual(params.runtimeWorkspaceRoots, []);
                    assert.isFalse(params.config.mcp_servers.inherited!.enabled);
                    yield* reply({
                      model: "gpt-6-luna",
                      reasoningEffort: "medium",
                      serviceTier: "priority",
                      approvalPolicy: "never",
                      sandbox: { type: "readOnly", networkAccess: false },
                      thread: { id: "private", environments: [] },
                      runtimeWorkspaceRoots: [],
                    });
                    break;
                  }
                  case "mcpServerStatus/list":
                    yield* reply({ data: [], nextCursor: null });
                    break;
                  case "turn/start": {
                    if (scenario === "mutation")
                      assert.include(
                        (frame.params as { input: Array<{ text: string }> }).input[0]!.text,
                        "button#selected",
                      );
                    assertStrictObjects((frame.params as { outputSchema: unknown }).outputSchema);
                    yield* reply({ turn: { id: "decision-turn" } });
                    if (scenario === "mcp" || scenario === "shell") {
                      yield* emit({
                        id: "unexpected",
                        method: "item/tool/call",
                        params: {
                          threadId: "private",
                          turnId: "decision-turn",
                          callId: "unexpected",
                          tool: scenario === "mcp" ? "mcp__inherited__mutate" : "exec_command",
                          arguments: { command: "must not execute" },
                        },
                      });
                    } else {
                      if (scenario === "clock")
                        yield* emit({
                          method: "item/completed",
                          params: {
                            threadId: "private",
                            turnId: "decision-turn",
                            completedAtMs: 0,
                            item: {
                              type: "functionCallOutput",
                              id: "time",
                              namespace: "clock",
                              name: "curr_time",
                              output: "2026-10-24",
                            },
                          },
                        });
                      yield* emit({
                        method: "item/completed",
                        params: {
                          threadId: "private",
                          turnId: "decision-turn",
                          completedAtMs: 0,
                          item: {
                            type: "agentMessage",
                            id: "result",
                            phase: "final_answer",
                            text: encode(expectedDecision),
                            ...(scenario === "async"
                              ? {
                                  delivery: "async",
                                  questions: [{ title: "Must not reach the user" }],
                                }
                              : {}),
                          },
                        },
                      });
                      yield* emit({
                        method: "turn/completed",
                        params: {
                          threadId: "private",
                          turn: { id: "decision-turn", items: [], status: "completed" },
                        },
                      });
                    }
                    break;
                  }
                  case "turn/interrupt":
                    yield* reply({});
                    break;
                  case "thread/unsubscribe":
                    yield* reply({ status: "unsubscribed" });
                    break;
                  default:
                    assert.fail(`Unexpected method ${frame.method}`);
                }
              }).pipe(Effect.orDie),
            ),
        }),
      );
      const result = yield* runCodexVoiceIntakeDecision(client, {
        cwd: "/private",
        snapshot: inputSnapshot,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
      }).pipe(Effect.result);
      if (scenario === "json" || scenario === "mutation" || scenario === "clock") {
        assert.isTrue(result._tag === "Success");
        if (result._tag === "Success")
          assert.deepEqual(result.success, yield* decodeDecision(expectedDecision));
      } else assert.isTrue(result._tag === "Failure");
      assert.include(methods, "thread/unsubscribe");
      assert.notInclude(methods, "thread/archive");
      if (scenario === "mcp" || scenario === "shell") {
        assert.equal(responses.length, 1);
        assert.deepInclude(responses[0], {
          id: "unexpected",
          result: {
            success: false,
            contentItems: [{ type: "inputText", text: "Decision tools are disabled." }],
          },
        });
      }
    }).pipe(Effect.scoped),
);

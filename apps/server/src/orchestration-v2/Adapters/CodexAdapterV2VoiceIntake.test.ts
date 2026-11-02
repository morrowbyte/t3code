import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, VoiceIntakeDecision, VoiceIntakeSnapshot } from "@t3tools/contracts";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import * as CodexClient from "effect-codex-app-server/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";

import {
  makeCodexVoiceIntakeDecider,
  voiceIntakeDecisionOutputSchema,
  voiceIntakeUnclaimedSpans,
} from "./CodexAdapterV2VoiceIntake.ts";

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
    baseInstructions: Schema.String,
    environments: Schema.Array(Schema.Unknown),
    runtimeWorkspaceRoots: Schema.Array(Schema.Unknown),
    config: Schema.Struct({
      mcp_servers: Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.Boolean })),
    }),
  }),
);
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceIntakeSnapshot));
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

it("limits native refinement and confirmation to eligible snapshot targets", () => {
  const intents = ["preparing", "starting", "running", "waiting", "queued", "completed"].map(
    (status) => ({
      id: status,
      status,
      request: "Existing work",
      provisional: false,
      sources: [],
      result: null,
    }),
  );
  intents.push({
    id: "research",
    status: "running",
    request: "Research",
    provisional: true,
    sources: [],
    result: null,
  });
  const validate = new AjvJsonSchemaValidator().getValidator(
    voiceIntakeDecisionOutputSchema({ ...snapshot, intents }) as JsonSchemaType,
  );
  const sources = [{ segmentId: "segment", revision: 1, quote: "Research runners." }];
  const accepts = (action: object) =>
    validate({ requestId: snapshot.requestId, actions: [action] }).valid;
  for (const status of ["preparing", "starting", "running", "waiting", "queued"])
    assert.isTrue(
      accepts({ type: "refine", intentId: status, sources, readOnly: false, message: "Change it" }),
    );
  for (const intentId of ["completed", "unknown"])
    assert.isFalse(
      accepts({ type: "refine", intentId, sources, readOnly: false, message: "Change it" }),
    );
  assert.isTrue(accepts({ type: "confirm", intentId: "research", sources }));
  assert.isFalse(accepts({ type: "confirm", intentId: "running", sources }));
  assert.isFalse(accepts({ type: "confirm", intentId: "completed", sources }));
  assert.isTrue(accepts({ type: "reference", intentId: "completed" }));
  assert.isFalse(accepts({ type: "reference", intentId: "unknown" }));
});

it("keeps new work and deferral available without a steerable target", () => {
  const validate = new AjvJsonSchemaValidator().getValidator(
    voiceIntakeDecisionOutputSchema(snapshot) as JsonSchemaType,
  );
  const accepts = (action: object) =>
    validate({ requestId: snapshot.requestId, actions: [action] }).valid;
  assert.isTrue(
    accepts({
      type: "new",
      sources: [{ segmentId: "segment", revision: 1, quote: "Research runners." }],
      request: "Research runners",
      readOnly: true,
      projectId: null,
    }),
  );
  assert.isTrue(accepts({ type: "defer", reason: "Need the requested change" }));
  assert.isFalse(accepts({ type: "reference", intentId: "unknown" }));
  assert.isFalse(
    accepts({
      type: "refine",
      intentId: "unknown",
      sources: [{ segmentId: "segment", revision: 1, quote: "Research runners." }],
      readOnly: false,
      message: "Change it",
    }),
  );
});

it("keeps new clauses visible after overlapping claimed ranges and ASR corrections", () => {
  const text = "Reset. Dann Gesendet anzeigen.";
  const input = {
    ...snapshot,
    segments: [{ ...snapshot.segments[0]!, text }],
    intents: [
      {
        id: "old",
        request: "Reset.",
        provisional: false,
        status: "completed",
        sources: [
          { segmentId: "segment", revision: 1, start: 0, end: 4 },
          { segmentId: "segment", revision: 1, start: 2, end: 6 },
        ],
        result: null,
      },
    ],
  };
  assert.deepEqual(voiceIntakeUnclaimedSpans(input), [
    { segmentId: "segment", revision: 1, text: " Dann Gesendet anzeigen." },
  ]);
  assert.deepEqual(
    voiceIntakeUnclaimedSpans({
      ...input,
      segments: [{ ...input.segments[0]!, revision: 2, text: "Stopp. Dann Gesendet anzeigen." }],
    }),
    [{ segmentId: "segment", revision: 2, text: "Stopp. Dann Gesendet anzeigen." }],
  );
});

it.effect.each([
  "json",
  "low",
  "mutation",
  "clock",
  "async",
  "mcp",
  "shell",
  "reuse",
  "rejection-feedback",
  "stale",
  "failure-reopen",
  "timeout-reopen",
  "close-active",
  "serial",
  "rotate",
  "wrong-request",
  "early",
  "native-error-reopen",
] as const)("isolates and reuses the actual protocol client (%s)", (scenario) =>
  Effect.gen(function* () {
    const inputSnapshot =
      scenario === "mutation"
        ? {
            ...snapshot,
            previewContext: "button#selected",
            segments: [{ ...snapshot.segments[0]!, text: "Change this selected button to green." }],
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
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-luna",
      ...(scenario === "low" ? { options: [{ id: "reasoningEffort", value: "low" }] } : {}),
    };
    const methods: string[] = [];
    const responses: unknown[] = [];
    const turnSnapshots: VoiceIntakeSnapshot[] = [];
    let decisionInstructions = "";
    const rejection = {
      requestId: "lease:1:1",
      snapshotVersion: 1,
      actionIndex: 0,
      anchorIndex: null,
      actionType: "new",
      code: "snapshot_retracted",
      disposition: "not_applied" as const,
      sources: [{ segmentId: "segment", revision: 1, quote: "Research runners." }],
    };
    const closedClients: number[] = [];
    let opens = 0;
    let turns = 0;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const decider = yield* makeCodexVoiceIntakeDecider("lease:1", () =>
      Effect.gen(function* () {
        const helperScope = yield* Scope.Scope;
        const openId = ++opens;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closedClients.push(openId);
          }),
        );
        const inbound = yield* Queue.unbounded<Uint8Array>();
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
                      decisionInstructions = params.baseInstructions;
                      assert.deepEqual(params.environments, []);
                      assert.deepEqual(params.runtimeWorkspaceRoots, []);
                      assert.isFalse(params.config.mcp_servers.inherited!.enabled);
                      yield* reply({
                        model: "gpt-6-luna",
                        reasoningEffort: scenario === "low" ? "low" : "medium",
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
                      const turnId = `decision-${++turns}`;
                      const params = frame.params as {
                        input: Array<{ text: string }>;
                        outputSchema: unknown;
                        sandboxPolicy: unknown;
                        approvalPolicy: unknown;
                      };
                      const text = params.input[0]!.text;
                      const currentSnapshot = yield* decodeSnapshot(
                        text.slice(0, text.indexOf("\n")),
                      );
                      turnSnapshots.push(currentSnapshot);
                      const { requestId } = currentSnapshot;
                      if (scenario === "mutation") assert.include(text, "button#selected");
                      assert.deepEqual(params.sandboxPolicy, {
                        type: "readOnly",
                        networkAccess: false,
                      });
                      assert.equal(params.approvalPolicy, "never");
                      assertStrictObjects(params.outputSchema);
                      if (scenario !== "early") yield* reply({ turn: { id: turnId } });
                      yield* Deferred.succeed(entered, undefined);
                      if (
                        (scenario === "timeout-reopen" || scenario === "close-active") &&
                        turns === 1
                      )
                        break;
                      if (scenario === "mcp" || scenario === "shell") {
                        yield* emit({
                          id: "unexpected",
                          method: "item/tool/call",
                          params: {
                            threadId: "private",
                            turnId,
                            callId: "unexpected",
                            tool: scenario === "mcp" ? "mcp__inherited__mutate" : "exec_command",
                            arguments: { command: "must not execute" },
                          },
                        });
                        break;
                      }
                      const expected = { ...expectedDecision, requestId };
                      const complete = Effect.gen(function* () {
                        if (scenario === "native-error-reopen" && turns === 1) {
                          yield* emit({
                            method: "error",
                            params: {
                              threadId: "private",
                              turnId,
                              willRetry: false,
                              error: { message: "fixture native error" },
                            },
                          });
                          return;
                        }
                        if (scenario === "serial" && turns === 1) yield* Deferred.await(release);
                        if (scenario === "stale" && turns > 1) {
                          yield* emit({
                            method: "error",
                            params: {
                              threadId: "private",
                              turnId: "decision-1",
                              willRetry: false,
                              error: { message: "stale error" },
                            },
                          });
                          yield* emit({
                            method: "item/completed",
                            params: {
                              threadId: "private",
                              turnId: "decision-1",
                              completedAtMs: 0,
                              item: {
                                type: "agentMessage",
                                id: "stale",
                                phase: "final_answer",
                                text: encode(decision),
                              },
                            },
                          });
                          yield* emit({
                            method: "turn/completed",
                            params: {
                              threadId: "private",
                              turn: { id: "decision-1", items: [], status: "completed" },
                            },
                          });
                        }
                        if (scenario === "clock")
                          yield* emit({
                            method: "item/completed",
                            params: {
                              threadId: "private",
                              turnId,
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
                            turnId,
                            completedAtMs: 0,
                            item: {
                              type: "agentMessage",
                              id: "result",
                              phase: "final_answer",
                              text:
                                scenario === "failure-reopen" && turns === 1
                                  ? "invalid JSON"
                                  : encode({
                                      ...expected,
                                      ...(scenario === "wrong-request"
                                        ? { requestId: "old-request" }
                                        : {}),
                                    }),
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
                            turn: { id: turnId, items: [], status: "completed" },
                          },
                        });
                      });
                      if (scenario === "early") {
                        yield* complete;
                        yield* reply({ turn: { id: turnId } });
                      } else yield* complete.pipe(Effect.forkIn(helperScope));
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
        return { client, cwd: "/private" };
      }),
    );
    yield* Effect.addFinalizer(() => decider.close);
    const decide = (version: number) =>
      decider.decide({
        snapshot: {
          ...inputSnapshot,
          version,
          requestId: `lease:1:${version}`,
          ...(scenario === "rejection-feedback" && version > 1 ? { rejections: [rejection] } : {}),
        },
        modelSelection,
      });
    const pending = yield* decide(1).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    let second:
      | Fiber.Fiber<VoiceIntakeDecision, Effect.Error<ReturnType<typeof decider.decide>>>
      | undefined;
    if (scenario === "serial") {
      second = yield* decide(2).pipe(Effect.forkChild({ startImmediately: true }));
      assert.equal(turns, 1);
      yield* Deferred.succeed(release, undefined);
    }
    if (scenario === "timeout-reopen") yield* TestClock.adjust("20 seconds");
    if (scenario === "close-active") yield* decider.close;
    const result = yield* Fiber.join(pending);
    if (
      [
        "async",
        "mcp",
        "shell",
        "failure-reopen",
        "timeout-reopen",
        "close-active",
        "wrong-request",
        "native-error-reopen",
      ].includes(scenario)
    ) {
      assert.equal(result._tag, "Failure");
      assert.deepEqual(closedClients, [1]);
    } else {
      assert.equal(result._tag, "Success");
      if (result._tag === "Success")
        assert.deepEqual(result.success, yield* decodeDecision(expectedDecision));
      assert.notInclude(methods, "thread/unsubscribe");
    }
    if (second) assert.equal((yield* Fiber.join(second)).requestId, "lease:1:2");
    if (
      scenario === "reuse" ||
      scenario === "rejection-feedback" ||
      scenario === "stale" ||
      scenario === "rotate"
    ) {
      const count = scenario === "rotate" ? 33 : 2;
      for (let version = 2; version <= count; version++)
        assert.equal((yield* decide(version)).requestId, `lease:1:${version}`);
      assert.equal(opens, scenario === "rotate" ? 2 : 1);
      for (const method of ["initialize", "config/read", "thread/start", "mcpServerStatus/list"])
        assert.equal(methods.filter((entry) => entry === method).length, opens, method);
      assert.equal(turns, count);
      const priorOpens = opens;
      const wrongLease = yield* decider
        .decide({ snapshot: { ...snapshot, generation: 2 }, modelSelection })
        .pipe(Effect.result);
      assert.equal(wrongLease._tag, "Failure");
      assert.equal(opens, priorOpens);
    }
    if (scenario === "rejection-feedback") {
      assert.include(
        decisionInstructions,
        "Current snapshot intents and their claimed sources are authoritative",
      );
      assert.include(decisionInstructions, "not_applied means that action never executed");
      assert.include(
        decisionInstructions,
        "without automatically retrying it or reviving a cancelled goal",
      );
      assert.deepEqual(turnSnapshots[1]!.rejections, [rejection]);
      assert.deepEqual(voiceIntakeUnclaimedSpans(turnSnapshots[1]!), [
        { segmentId: "segment", revision: 1, text: "Research runners." },
      ]);
      const validate = new AjvJsonSchemaValidator().getValidator(
        voiceIntakeDecisionOutputSchema(turnSnapshots[1]!) as JsonSchemaType,
      );
      assert.isFalse(
        validate({
          requestId: "lease:1:2",
          actions: [{ type: "reference", intentId: "lease:1:1:0" }],
        }).valid,
      );
    }
    if (
      scenario === "failure-reopen" ||
      scenario === "timeout-reopen" ||
      scenario === "native-error-reopen"
    ) {
      assert.equal((yield* decide(2)).requestId, "lease:1:2");
      assert.equal(opens, 2);
    }
    yield* decider.close;
    assert.equal(closedClients.length, opens);
    const stopped = yield* decide(99).pipe(Effect.result);
    assert.equal(stopped._tag, "Failure");
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

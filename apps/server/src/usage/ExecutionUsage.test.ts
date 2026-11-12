import { expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ExecutionUsage from "./ExecutionUsage.ts";

const layer = ExecutionUsage.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(NodeCrypto.layer),
);
const time = "2026-11-12T10:00:00.000Z";

const seed = Effect.fn("test.seedExecution")(function* (
  id: string,
  options: {
    project?: string;
    parent?: string;
    cost?: number;
    admission?: boolean;
    origin?: string;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const thread = `thread:${id}`;
  const run = `run:${id}`;
  const payload = JSON.stringify({
    modelSelection: {
      instanceId: "codex",
      model: id,
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    userMessageId: `message:${id}`,
    startedAt: time,
    ...(options.admission ? { delegationAdmission: {} } : {}),
  });
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${thread}, ${options.project ?? "project:a"}, ${id}, 'codex', 'auto', 'default', ${time}, ${time},
      ${JSON.stringify({ lineage: { parentThreadId: options.parent ?? null, relationshipToParent: options.parent ? "subagent" : null } })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs
    (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json)
    VALUES (${run}, ${thread}, 1, 'codex', 'completed', ${time}, '2026-11-12T10:01:00.000Z', ${payload})`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages
    (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json)
    VALUES (${`message:${id}`}, ${thread}, ${run}, 'user', 0, ${time}, ${time},
      ${JSON.stringify({ text: "Fix the same task", creationSource: options.origin ?? "web" })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_run_attempts
    (attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider, provider_thread_id, status, payload_json)
    VALUES (${`attempt:${id}`}, ${thread}, ${run}, 1, 'node', 'codex', 'provider-thread', 'completed', '{}')`;
  const cost =
    options.cost === undefined
      ? undefined
      : {
          status: "complete",
          model: id,
          serviceTier: "standard",
          source: "litellm",
          pricedAt: time,
          ratesFetchedAt: time,
          amountUsd: options.cost,
          usage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 100,
            outputTokens: 20,
            hasSubagents: false,
          },
        };
  yield* sql`INSERT INTO orchestration_v2_projection_provider_turns
    (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, payload_json)
    VALUES (${`turn:${id}`}, ${thread}, ${`provider-thread:${id}`}, 'node', ${`attempt:${id}`}, 1, 'completed', ${JSON.stringify({ cost, ...(options.cost === undefined ? {} : { tokenUsage: { usedTokens: 12000, maxTokens: 100000, updatedAt: time } }) })})`;
});

it.effect(
  "attributes saved runs and child/voice usage without turning missing measurements into zero",
  () =>
    Effect.gen(function* () {
      yield* seed("parent", { cost: 0.02 });
      yield* seed("child", { parent: "thread:parent", origin: "voice" });
      yield* seed("cross-project-child", {
        parent: "thread:parent",
        project: "project:other",
        cost: 0.03,
      });
      yield* seed("other", { project: "project:other", cost: 100 });
      yield* seed("admission", { admission: true, cost: 100 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_subagents
      (subagent_id, thread_id, run_id, parent_node_id, provider, origin, status, updated_at, payload_json)
      VALUES ('native-child', 'thread:parent', 'run:parent', 'node', 'codex', 'provider_native', 'completed', ${time},
        ${JSON.stringify({ title: "Native review", model: "child-model", modelSelection: { instanceId: "codex", model: "child-model", options: [{ id: "serviceTier", value: "priority" }] } })})`;
      const usage = yield* ExecutionUsage.ExecutionUsage;
      const project = yield* usage.read({ projectId: ProjectId.make("project:a") });
      expect(project.entries).toHaveLength(2);
      const parent = project.entries.find((entry) => entry.threadId === "thread:parent")!;
      const child = project.entries.find((entry) => entry.threadId === "thread:child")!;
      expect(parent.estimatedCostUsd).toBe(0.02);
      expect(parent.durationMs).toBe(60_000);
      expect(parent).toMatchObject({ contextUsedTokens: 12000, contextMaxTokens: 100000 });
      expect(parent.modelSelection.options).toEqual([{ id: "reasoningEffort", value: "high" }]);
      expect(child).toMatchObject({
        estimatedCostUsd: null,
        inputTokens: null,
        outputTokens: null,
        missingCostTurns: 1,
        partial: true,
        origin: "voice",
        parentThreadId: "thread:parent",
      });
      expect(parent.taskKey).toBe(child.taskKey);
      expect(child.contextUsedTokens).toBeNull();
      expect(parent.nativeChildren[0]).toMatchObject({
        model: "child-model",
        modelSelection: { options: [{ id: "serviceTier", value: "priority" }] },
      });
      expect(parent.unmeasuredSubagents).toBe(true);
      expect(parent.pricing[0]).toMatchObject({ source: "litellm", pricedAt: time });
      expect(
        (yield* usage.read({
          projectId: ProjectId.make("project:a"),
          threadId: ThreadId.make("thread:parent"),
        })).entries,
      ).toHaveLength(3);
      expect(
        (yield* usage.read({
          projectId: ProjectId.make("project:other"),
          threadId: ThreadId.make("thread:parent"),
        })).entries,
      ).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${time} WHERE thread_id = 'thread:child'`;
      expect(
        (yield* usage.read({ threadId: ThreadId.make("thread:parent") })).entries,
      ).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);

it.effect("bounds history and preserves measured zero instead of unknown", () =>
  Effect.gen(function* () {
    yield* Effect.forEach(
      Array.from({ length: 101 }, (_, index) => String(index)),
      (id) => seed(id, { cost: 0 }),
      { discard: true },
    );
    const usage = yield* ExecutionUsage.ExecutionUsage;
    const summary = yield* usage.read({});
    expect(summary.entries).toHaveLength(100);
    expect(summary.truncated).toBe(true);
    expect(summary.entries.every((entry) => entry.estimatedCostUsd === 0 && !entry.partial)).toBe(
      true,
    );
  }).pipe(Effect.provide(layer)),
);

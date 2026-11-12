import {
  type ExecutionUsageInput,
  type ExecutionUsageSummary,
  ModelSelection,
  ProjectId,
  RunId,
  ThreadId,
  TurnCostSnapshot,
  UsageReadError,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Hex from "effect/encoding/Hex";

const decodeSelection = Schema.decodeUnknownSync(Schema.fromJsonString(ModelSelection));
const decodeCost = Schema.decodeUnknownOption(Schema.fromJsonString(TurnCostSnapshot));

export class ExecutionUsage extends Context.Service<
  ExecutionUsage,
  {
    readonly read: (
      input: ExecutionUsageInput,
    ) => Effect.Effect<ExecutionUsageSummary, UsageReadError>;
  }
>()("t3/usage/ExecutionUsage") {}

export const layer = Layer.effect(
  ExecutionUsage,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const read = Effect.fn("ExecutionUsage.read")(
      function* (input: ExecutionUsageInput) {
        const rows = yield* sql<{
          run_id: string;
          thread_id: string;
          project_id: string;
          title: string;
          parent_thread_id: string | null;
          selection: string;
          origin: string | null;
          status: string;
          requested_at: string;
          started_at: string | null;
          completed_at: string | null;
          task_key: string | null;
          prompt: string | null;
          result: string | null;
          delegated_children: number;
        }>`
      WITH RECURSIVE scoped(thread_id) AS (
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId ?? null}
          AND deleted_at IS NULL
          AND (${input.projectId ?? null} IS NULL OR project_id = ${input.projectId ?? null})
        UNION
        -- Keep parents outermost and remove CTE text affinity for the JSON expression index.
        SELECT t.thread_id FROM scoped s CROSS JOIN orchestration_v2_projection_threads t
        WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') = +s.thread_id
          AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          AND t.deleted_at IS NULL
      )
      SELECT r.run_id, r.thread_id, t.project_id, t.title,
        json_extract(t.payload_json, '$.lineage.parentThreadId') AS parent_thread_id,
        json_extract(r.payload_json, '$.modelSelection') AS selection,
        json_extract(m.payload_json, '$.creationSource') AS origin,
        r.status, r.requested_at, json_extract(r.payload_json, '$.startedAt') AS started_at, r.completed_at,
        json_extract(m.payload_json, '$.text') AS task_key,
        substr(json_extract(m.payload_json, '$.text'), 1, 1200) AS prompt,
        (SELECT COUNT(*) FROM orchestration_v2_projection_subagents c
          WHERE c.run_id = r.run_id AND c.origin = 'app_owned') AS delegated_children,
        (SELECT substr(json_extract(a.payload_json, '$.text'), 1, 2400)
          FROM orchestration_v2_projection_messages a WHERE a.run_id = r.run_id AND a.role = 'assistant'
          ORDER BY a.created_at DESC, a.message_id DESC LIMIT 1) AS result
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
      LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
      WHERE t.deleted_at IS NULL
        AND (${input.threadId ?? null} IS NOT NULL OR ${input.projectId ?? null} IS NULL OR t.project_id = ${input.projectId ?? null})
        AND (${input.threadId ?? null} IS NULL OR t.thread_id IN (SELECT thread_id FROM scoped))
        AND json_extract(r.payload_json, '$.delegationAdmission') IS NULL
      ORDER BY r.requested_at DESC, r.run_id DESC LIMIT 101
    `;
        const selected = rows.slice(0, 100);
        if (selected.length === 0) return { entries: [], truncated: false };
        const turns = yield* sql<{
          run_id: string;
          cost: string | null;
          context_used: number | null;
          context_max: number | null;
          context_at: string | null;
        }>`
      SELECT a.run_id, json_extract(p.payload_json, '$.cost') AS cost,
        json_extract(p.payload_json, '$.tokenUsage.usedTokens') AS context_used,
        json_extract(p.payload_json, '$.tokenUsage.maxTokens') AS context_max,
        json_extract(p.payload_json, '$.tokenUsage.updatedAt') AS context_at
      FROM orchestration_v2_projection_provider_turns p
      JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = p.run_attempt_id
      WHERE ${sql.in(
        "a.run_id",
        selected.map((row) => row.run_id),
      )}
    `;
        const nativeChildren = yield* sql<{
          subagent_id: string;
          run_id: string;
          title: string | null;
          model: string | null;
          selection: string | null;
          status: string;
          total: number;
        }>`WITH children AS (
      SELECT subagent_id, run_id, status, json_extract(payload_json, '$.title') AS title,
        json_extract(payload_json, '$.model') AS model,
        json_extract(payload_json, '$.modelSelection') AS selection,
        COUNT(*) OVER (PARTITION BY run_id) AS total,
        ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY updated_at DESC, subagent_id) AS position
      FROM orchestration_v2_projection_subagents
      WHERE origin = 'provider_native' AND ${sql.in(
        "run_id",
        selected.map((row) => row.run_id),
      )}
    ) SELECT * FROM children WHERE position <= 20`;
        const entries = yield* Effect.forEach(selected, (row) =>
          Effect.gen(function* () {
            const children = nativeChildren.filter((child) => child.run_id === row.run_id);
            const runTurns = turns.filter((turn) => turn.run_id === row.run_id);
            const context = runTurns
              .filter((turn) => turn.context_used !== null)
              .toSorted((a, b) => (b.context_at ?? "").localeCompare(a.context_at ?? ""))[0];
            const costs = runTurns.map((turn) =>
              turn.cost === null ? null : Option.getOrNull(decodeCost(turn.cost)),
            );
            const known = costs.flatMap((cost) =>
              cost !== null && cost.amountUsd !== undefined && cost.status !== "unavailable"
                ? [cost]
                : [],
            );
            const missingCostTurns = costs.length === 0 ? 1 : costs.length - known.length;
            const inputCounts = costs.map((cost) => cost?.usage?.inputTokens);
            const outputCounts = costs.map((cost) => cost?.usage?.outputTokens);
            const total = (counts: readonly (number | undefined)[]) =>
              counts.length > 0 && counts.every((value) => value !== undefined)
                ? counts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
                : null;
            const started = row.started_at === null ? NaN : Date.parse(row.started_at);
            const completed = row.completed_at === null ? NaN : Date.parse(row.completed_at);
            const taskKey = row.task_key
              ? Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(row.task_key)))
              : "";
            return {
              runId: RunId.make(row.run_id),
              threadId: ThreadId.make(row.thread_id),
              projectId: ProjectId.make(row.project_id),
              threadTitle: row.title,
              parentThreadId:
                row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
              modelSelection: decodeSelection(row.selection),
              origin: row.origin ?? "unknown",
              status: row.status,
              requestedAt: row.requested_at,
              durationMs:
                Number.isFinite(started) && Number.isFinite(completed) && completed >= started
                  ? completed - started
                  : null,
              taskKey,
              prompt: row.prompt ?? "",
              result: row.result ?? "",
              estimatedCostUsd:
                known.length > 0
                  ? known.reduce((sum, cost) => sum + (cost.amountUsd ?? 0), 0)
                  : null,
              inputTokens: total(inputCounts),
              outputTokens: total(outputCounts),
              missingCostTurns,
              contextUsedTokens: context?.context_used ?? null,
              contextMaxTokens: context?.context_max ?? null,
              partial: missingCostTurns > 0 || known.some((cost) => cost.status === "partial"),
              unmeasuredSubagents:
                children.length > 0 || costs.some((cost) => cost?.usage?.hasSubagents === true),
              delegatedChildren: row.delegated_children,
              nativeChildren: children.map((child) => ({
                id: child.subagent_id,
                title: child.title ?? "Native child",
                model: child.model,
                modelSelection: child.selection === null ? null : decodeSelection(child.selection),
                status: child.status,
              })),
              nativeChildrenOmitted: Math.max(0, (children[0]?.total ?? 0) - children.length),
              pricing: [
                ...new Map(
                  known.map((cost) => {
                    const pricing = {
                      source: cost.source,
                      pricedAt: cost.pricedAt,
                      model: cost.model,
                      serviceTier: cost.serviceTier,
                    };
                    return [JSON.stringify(pricing), pricing] as const;
                  }),
                ).values(),
              ],
            };
          }),
        );
        return { entries, truncated: rows.length > 100 };
      },
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read saved executions.",
            cause,
          }),
      ),
      NodeSqliteClient.readOnly,
    );
    return ExecutionUsage.of({ read });
  }),
);

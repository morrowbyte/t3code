import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_usage_history_idx
    ON orchestration_v2_projection_runs(requested_at DESC, run_id DESC)
    WHERE json_extract(payload_json, '$.delegationAdmission') IS NULL
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_provider_turns_attempt_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_subagents_run_origin_idx
    ON orchestration_v2_projection_subagents(run_id, origin, updated_at DESC, subagent_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_subagent_parent_idx
    ON orchestration_v2_projection_threads(json_extract(payload_json, '$.lineage.parentThreadId'))
    WHERE json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent'
      AND deleted_at IS NULL
  `;
});

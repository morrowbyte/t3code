import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_threads_subagent_parent_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_threads_subagent_parent_idx
    ON orchestration_v2_projection_threads(
      CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.lineage.parentThreadId') END
    )
    WHERE CASE WHEN json_valid(payload_json)
      THEN json_extract(payload_json, '$.lineage.relationshipToParent') = 'subagent' ELSE 0 END
      AND deleted_at IS NULL
  `;
});

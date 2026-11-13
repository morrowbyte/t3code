import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP INDEX IF EXISTS orchestration_v2_projection_runs_usage_history_idx`;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_runs_usage_history_idx
    ON orchestration_v2_projection_runs(requested_at DESC, run_id DESC)
  `;
});

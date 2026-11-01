import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_runtime_recovery_ordinal_idx
    ON orchestration_v2_projection_turn_items(thread_id, ordinal, turn_item_id)
    WHERE status IN ('pending', 'running', 'waiting')
      OR CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.privilegedCommand.state') IN ('approved', 'claimed')
        ELSE 0 END
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_requests_runtime_recovery_idx
    ON orchestration_v2_projection_runtime_requests(thread_id, created_at, runtime_request_id)
    WHERE status = 'pending'
      OR CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.privilegedCommand.state') IN ('approved', 'claimed')
        ELSE 0 END
  `;
});

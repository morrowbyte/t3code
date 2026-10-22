import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_approval_review_ready_idx
    ON orchestration_v2_projection_runtime_requests(
      json_extract(payload_json, '$.approvalReview.workerSubject'), created_at, runtime_request_id
    )
    WHERE status = 'resolved' AND json_extract(payload_json, '$.approvalReview.state') = 'approved'`;
});

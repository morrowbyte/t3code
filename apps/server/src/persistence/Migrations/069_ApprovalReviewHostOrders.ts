import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE approval_review_host_orders (
    order_id TEXT PRIMARY KEY,
    human_session_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    source_json TEXT NOT NULL,
    channel_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('forwarding','active','forward-unknown','cancelled')),
    assignment_json TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(human_session_id, client_request_id)
  )`;
  yield* sql`CREATE TRIGGER approval_review_host_order_immutable
    BEFORE UPDATE OF order_id, human_session_id, client_request_id, source_json, channel_json, expires_at, created_at
    ON approval_review_host_orders BEGIN SELECT RAISE(ABORT, 'immutable host order'); END`;
  yield* sql`CREATE TABLE approval_review_order_proposals (
    order_id TEXT NOT NULL REFERENCES approval_review_host_orders(order_id),
    submission_id TEXT NOT NULL,
    request_id TEXT NOT NULL UNIQUE,
    package_hash TEXT NOT NULL,
    PRIMARY KEY(order_id, submission_id)
  )`;
  yield* sql`CREATE TABLE approval_review_order_deliveries (
    host_session_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('receiving','received','unknown')),
    ack_json TEXT,
    PRIMARY KEY(host_session_id, order_id)
  )`;
});

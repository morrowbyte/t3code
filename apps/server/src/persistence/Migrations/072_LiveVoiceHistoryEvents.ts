import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE codex_live_voice_history_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    recorded_at TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('status', 'transcript')),
    status TEXT,
    event_json TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX codex_live_voice_history_call_idx
    ON codex_live_voice_history_events(environment_id, thread_id, lease_id, generation, event_id)`;
});

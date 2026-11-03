import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE codex_live_voice_diagnostics_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1))
  )`;
  yield* sql`INSERT INTO codex_live_voice_diagnostics_settings (id, enabled) VALUES (1, 0)`;
  yield* sql`CREATE TABLE codex_live_voice_diagnostics (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    environment_id TEXT NOT NULL, thread_id TEXT NOT NULL, lease_id TEXT NOT NULL,
    generation INTEGER NOT NULL, recorded_at TEXT NOT NULL, event_json TEXT NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE
  )`;
  yield* sql`CREATE INDEX codex_live_voice_diagnostics_call_idx
    ON codex_live_voice_diagnostics(environment_id, thread_id, lease_id, generation, sequence)`;
});

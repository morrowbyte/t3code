import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN delivery_generation TEXT NOT NULL DEFAULT ''`;
  yield* sql`UPDATE scheduled_tasks SET delivery_generation = lower(hex(randomblob(16)))`;
});

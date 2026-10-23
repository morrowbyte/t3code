import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect(
  "places a runless result at the explicit tail while preserving historical positions",
  () =>
    Effect.gen(function* () {
      const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
      const threadId = ThreadId.make("thread:runless-result-tail");
      const tail = {
        threadId,
        runId: RunId.make("run:current-parent-work"),
        runOrdinal: 12,
      };
      yield* positions.allocate({ ...tail, turnItemId: TurnItemId.make("item:parent-input") });
      assert.equal(
        yield* positions.allocate({ ...tail, turnItemId: TurnItemId.make("item:parent-task") }),
        12_000_002,
      );
      const result = {
        threadId,
        turnItemId: TurnItemId.make("item:runless-public-result"),
        runId: null,
        runOrdinal: 12,
      };
      assert.equal(yield* positions.allocate(result), 12_000_003);
      assert.equal(yield* positions.allocate(result), 12_000_003);
      const history = {
        threadId,
        turnItemId: TurnItemId.make("item:runless-historical-message"),
        runId: null,
      };
      assert.equal(yield* positions.allocate(history), 1);
      assert.equal(yield* positions.allocate(history), 1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

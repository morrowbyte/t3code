import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeUpdateHistory, updateHistoryUuid } from "./updateHistory.ts";

it.layer(NodeServices.layer)("durable update receipts", (it) => {
  it.effect("uses injected UUID methods and Effect values lazily and preserves failures", () =>
    Effect.gen(function* () {
      let calls = 0;
      let methodCalls = 0;
      const methodService = {
        prefix: "injected-method",
        randomUUIDv4() {
          methodCalls += 1;
          return Effect.sync(() => `${this.prefix}-${++calls}`);
        },
      };
      const method = updateHistoryUuid(methodService);
      expect(calls).toBe(0);
      expect(methodCalls).toBe(0);
      expect(yield* method).toBe("injected-method-1");
      expect(yield* method).toBe("injected-method-2");
      expect(methodCalls).toBe(2);
      const value = updateHistoryUuid({
        randomUUIDv4: Effect.sync(() => `injected-value-${++calls}`),
      });
      expect(calls).toBe(2);
      expect(yield* value).toBe("injected-value-3");
      const error = { reason: "injected UUID failure" };
      expect(
        yield* Effect.flip(updateHistoryUuid({ randomUUIDv4: () => Effect.fail(error) })),
      ).toBe(error);
      expect(yield* Effect.flip(updateHistoryUuid({ randomUUIDv4: Effect.fail(error) }))).toBe(
        error,
      );
    }),
  );

  it.effect(
    "retains outcomes across reconstruction and prevents late writes or deletion from reviving them",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped();
        const file = path.join(dir, "history.json");
        const journal = yield* makeUpdateHistory(file);
        const id = yield* journal.start("server", "1.0.0", "1.1.0");
        yield* journal.patch(id, "awaiting-restart", { receiptId: "canonical-id" });
        expect((yield* journal.list)[0]?.status).toBe("awaiting-restart");
        expect((yield* Effect.flip(journal.remove(id))).reason).toContain("still in progress");
        yield* journal.patch(id, "succeeded", { observedVersion: "1.1.0" });
        const completed = (yield* journal.list)[0]!;
        const restarted = yield* makeUpdateHistory(file);
        expect(yield* restarted.list).toEqual([completed]);
        yield* restarted.patch(id, "failed", { error: "late callback" });
        expect(yield* restarted.list).toEqual([completed]);
        yield* restarted.remove(id);
        const reopened = yield* makeUpdateHistory(file);
        yield* reopened.add({ ...completed, id: "canonical-id" });
        expect(yield* reopened.list).toEqual([]);
      }),
  );

  it.effect("keeps concurrent attempts isolated and preserves a damaged journal for recovery", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped();
      const file = path.join(dir, "history.json");
      const journal = yield* makeUpdateHistory(file);
      const ids = yield* Effect.all(
        [journal.start("server", null, "1.1.0"), journal.start("server", "1.0.0", "1.2.0")],
        { concurrency: "unbounded" },
      );
      yield* journal.patch(ids[0], "failed", { error: "preflight rejected" });
      expect((yield* journal.list).find((entry) => entry.id === ids[1])?.status).toBe(
        "downloading",
      );
      yield* fs.writeFileString(file, "broken journal");
      expect((yield* Effect.flip(journal.start("server", null, null))).reason).toContain(
        "Could not read",
      );
      expect(yield* fs.readFileString(file)).toBe("broken journal");
    }),
  );
});

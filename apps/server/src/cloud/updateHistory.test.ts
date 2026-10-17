import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeServerUpdateHistory } from "./updateHistory.ts";
import { SERVICE_LAUNCHER_PROTOCOL, SERVICE_STATE_FILE } from "./serviceProtocol.ts";

it.layer(NodeServices.layer)("server update history recovery", (it) => {
  it.effect.each(["committed", "rolled-back", "wrong-id", "wrong-version", "pending"] as const)(
    "reconciles %s using the canonical receipt and running version",
    (scenario) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped();
        const before = yield* makeServerUpdateHistory(base, "1.0.0");
        yield* before.recover;
        const id = yield* before.start("server", "1.0.0", "1.1.0");
        yield* before.patch(id, "awaiting-restart", { receiptId: "receipt" });
        const status =
          scenario === "rolled-back" || scenario === "pending" ? scenario : "committed";
        yield* fs.writeFileString(
          path.join(base, "runtime", SERVICE_STATE_FILE),
          JSON.stringify({
            protocol: SERVICE_LAUNCHER_PROTOCOL,
            activeVersion: status === "committed" ? "1.1.0" : "1.0.0",
            update: {
              id: scenario === "wrong-id" ? "unrelated" : "receipt",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              status,
              ...(status === "pending" ? { dbPath: "/unused" } : {}),
              ...(status === "rolled-back"
                ? { reason: "Startup trial failed; previous version restored." }
                : {}),
            },
          }),
        );
        const running =
          scenario === "wrong-version" ? "1.0.0" : status === "committed" ? "1.1.0" : "1.0.0";
        const after = yield* makeServerUpdateHistory(base, running);
        const entry = (yield* after.list).find((entry) => entry.id === id)!;
        expect(entry.status).toBe(
          scenario === "committed"
            ? "succeeded"
            : scenario === "rolled-back"
              ? "rolled-back"
              : "interrupted",
        );
        expect(entry.observedVersion).toBe(running);
        expect(entry.completedAt).not.toBeNull();
        if (scenario === "committed") {
          yield* after.remove(id);
          const again = yield* makeServerUpdateHistory(base, running);
          expect(yield* again.list).toEqual([]);
        }
      }),
  );
});

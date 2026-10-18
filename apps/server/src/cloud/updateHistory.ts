import { isHostUpdateTerminal, type HostUpdateRecord } from "@t3tools/contracts";
import { makeUpdateHistory } from "@t3tools/shared/updateHistory";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import { parseServiceState, SERVICE_STATE_FILE } from "./serviceProtocol.ts";

export const makeServerUpdateHistory = Effect.fn("cloud.updateHistory.make")(function* (
  baseDir: string,
  currentVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const journal = yield* makeUpdateHistory(
    path.join(baseDir, "runtime", "server-update-history.json"),
  );
  const mutex = yield* Semaphore.make(1);
  let recovered = false;
  const recover = mutex.withPermits(1)(
    Effect.gen(function* () {
      if (recovered) return;
      const saved = yield* journal.list;
      const raw = yield* fs
        .readFileString(path.join(baseDir, "runtime", SERVICE_STATE_FILE))
        .pipe(Effect.option);
      const receipt = Option.isSome(raw) ? parseServiceState(raw.value)?.update : undefined;
      const terminal = receipt !== undefined && receipt.status !== "pending" ? receipt : undefined;
      const verified =
        terminal !== undefined &&
        currentVersion ===
          (terminal.status === "committed" ? terminal.targetVersion : terminal.fromVersion);
      for (const entry of saved) {
        if (isHostUpdateTerminal(entry.status)) continue;
        const matches =
          verified &&
          entry.receiptId === terminal.id &&
          entry.fromVersion === terminal.fromVersion &&
          entry.targetVersion === terminal.targetVersion;
        yield* journal.patch(
          entry.id,
          matches
            ? terminal.status === "committed"
              ? "succeeded"
              : terminal.status === "rolled-back"
                ? "rolled-back"
                : "failed"
            : "interrupted",
          {
            observedVersion: currentVersion,
            error: matches
              ? (terminal.reason ?? null)
              : "The server restarted without a matching completed update receipt. Check the running version and service logs before retrying.",
          },
        );
      }
      // An older runtime may have produced only the launcher's canonical receipt.
      if (
        verified &&
        !saved.some((entry) => entry.receiptId === terminal.id || entry.id === terminal.id)
      ) {
        const now = DateTime.formatIso(yield* DateTime.now);
        const record: HostUpdateRecord = {
          id: terminal.id,
          receiptId: terminal.id,
          component: "server",
          fromVersion: terminal.fromVersion,
          targetVersion: terminal.targetVersion,
          observedVersion: currentVersion,
          startedAt: null,
          updatedAt: now,
          completedAt: now,
          status:
            terminal.status === "committed"
              ? "succeeded"
              : terminal.status === "rolled-back"
                ? "rolled-back"
                : "failed",
          error: terminal.reason ?? null,
        };
        yield* journal.add(record);
      }
      recovered = true;
    }),
  );
  return { ...journal, recover, list: recover.pipe(Effect.andThen(journal.list)) };
});

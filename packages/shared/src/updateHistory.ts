import {
  HostUpdateHistoryError,
  HostUpdateRecord,
  isHostUpdateTerminal,
  type HostUpdateStatus,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const Journal = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    entries: Schema.Array(HostUpdateRecord),
    deletedReceiptIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
);
const decode = Schema.decodeUnknownEffect(Journal);
const encode = Schema.encodeEffect(Journal);

/** One updater owns each journal. Atomic replacement preserves the last receipt on a failed write. */
export const makeUpdateHistory = Effect.fn("updates.history.make")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const mutex = yield* Semaphore.make(1);
  const failure = (reason: string) => new HostUpdateHistoryError({ reason });
  const read = Effect.suspend(() => fs.readFileString(file)).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed('{"version":1,"entries":[]}')
          : Effect.fail(
              failure("Could not read update history. Check access to the T3 data directory."),
            ),
    }),
    Effect.flatMap(decode),
    Effect.mapError(() =>
      failure("Could not read update history. The saved file may be damaged or inaccessible."),
    ),
  );
  const write = (journal: typeof Journal.Type) =>
    Effect.gen(function* () {
      const text = yield* encode(journal);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      yield* fs.writeFileString(temporary, text);
      yield* fs.rename(temporary, file);
    }).pipe(
      Effect.mapError(() =>
        failure(
          "Could not save update history. Check free disk space and access to the T3 data directory.",
        ),
      ),
    );
  const modify = <A>(
    f: (entries: ReadonlyArray<HostUpdateRecord>) => readonly [A, ReadonlyArray<HostUpdateRecord>],
  ) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const journal = yield* read;
        const [result, next] = f(journal.entries);
        yield* write({ ...journal, entries: next });
        return result;
      }),
    );

  const add = (record: HostUpdateRecord) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        const journal = yield* read;
        if (
          !journal.entries.some((entry) => entry.id === record.id) &&
          !journal.deletedReceiptIds?.includes(record.receiptId ?? record.id)
        )
          yield* write({ ...journal, entries: [record, ...journal.entries] });
        return record.id;
      }),
    );
  return {
    list: mutex.withPermits(1)(read.pipe(Effect.map((journal) => journal.entries))),
    add,
    start: (
      component: HostUpdateRecord["component"],
      fromVersion: string | null,
      targetVersion: string | null,
    ) =>
      Effect.gen(function* () {
        const id = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => failure("Could not create an update receipt.")),
        );
        const now = DateTime.formatIso(yield* DateTime.now);
        return yield* add({
          id,
          component,
          fromVersion,
          targetVersion,
          observedVersion: null,
          startedAt: now,
          updatedAt: now,
          completedAt: null,
          status: "downloading",
          error: null,
        });
      }),
    patch: (
      id: string,
      status: HostUpdateStatus,
      details: Partial<
        Pick<HostUpdateRecord, "error" | "observedVersion" | "receiptId" | "targetVersion">
      > = {},
    ) =>
      Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* modify((entries) => [
          undefined,
          entries.map((entry) =>
            entry.id !== id || isHostUpdateTerminal(entry.status)
              ? entry
              : {
                  ...entry,
                  ...details,
                  status,
                  updatedAt: now,
                  completedAt: isHostUpdateTerminal(status) ? now : null,
                },
          ),
        ]);
      }),
    remove: (id: string) =>
      mutex.withPermits(1)(
        Effect.gen(function* () {
          const journal = yield* read;
          const entries = journal.entries;
          if (entries.some((entry) => entry.id === id && !isHostUpdateTerminal(entry.status)))
            return yield* failure(
              "An update is still in progress. Its receipt cannot be deleted yet.",
            );
          const removed = entries.find((entry) => entry.id === id);
          yield* write({
            ...journal,
            entries: entries.filter((entry) => entry.id !== id),
            deletedReceiptIds: [
              ...(journal.deletedReceiptIds ?? []),
              ...(removed ? [removed.receiptId ?? removed.id] : []),
            ],
          });
        }),
      ),
  };
});

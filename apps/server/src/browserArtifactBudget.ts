import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

const BROWSER_SCREENSHOT_BUDGET_BYTES = 512 * 1024 * 1024;
const MAX_BROWSER_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const PROTECTED_AGE_MS = 10 * 60 * 1000;
const managedName = /^browser-screenshot-[a-z0-9-]+-[a-z0-9]+-[0-9a-f]{8}\.png$/;
const writeGate = Semaphore.makeUnsafe(1);

export class BrowserArtifactBudgetError extends Schema.TaggedError<BrowserArtifactBudgetError>()(
  "BrowserArtifactBudgetError",
  { reason: Schema.Literals(["too-large", "capacity", "unsafe-path"]) },
) {
  override get message(): string {
    switch (this.reason) {
      case "too-large":
        return "The screenshot exceeds the 64 MiB image limit.";
      case "capacity":
        return "Screenshot storage is full. Recent captures are protected; wait before taking more screenshots or remove unneeded captures in Storage settings.";
      case "unsafe-path":
        return "Screenshot storage must be an app-owned directory without symbolic links.";
    }
  }
}

// Admission, eviction and the write share one gate so concurrent tool calls cannot
// each consume the same remaining budget. Fresh captures stay available to callers.
export const writeBrowserScreenshot = Effect.fn("BrowserArtifactBudget.write")(function* (input: {
  readonly directory: string;
  readonly fileName: string;
  readonly data: Uint8Array;
  readonly budgetBytes?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!managedName.test(input.fileName))
    return yield* new BrowserArtifactBudgetError({ reason: "unsafe-path" });
  if (input.data.byteLength > MAX_BROWSER_SCREENSHOT_BYTES)
    return yield* new BrowserArtifactBudgetError({ reason: "too-large" });
  return yield* writeGate.withPermit(
    Effect.gen(function* () {
      yield* fs.makeDirectory(input.directory, { recursive: true });
      const directory = yield* fs.realPath(input.directory);
      if (directory !== path.resolve(input.directory))
        return yield* new BrowserArtifactBudgetError({ reason: "unsafe-path" });
      const now = yield* Clock.currentTimeMillis;
      const entries: { file: string; bytes: number; modified: number }[] = [];
      for (const name of yield* fs.readDirectory(directory)) {
        if (!managedName.test(name)) continue;
        const file = path.join(directory, name);
        const resolved = yield* fs.realPath(file).pipe(Effect.option);
        if (Option.isNone(resolved) || resolved.value !== file) continue;
        const stat = yield* fs.stat(file).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "File") continue;
        entries.push({
          file,
          bytes: Number(stat.value.size),
          modified: Option.getOrNull(stat.value.mtime)?.getTime() ?? now,
        });
      }
      const budget = Math.min(
        input.budgetBytes ?? BROWSER_SCREENSHOT_BUDGET_BYTES,
        BROWSER_SCREENSHOT_BUDGET_BYTES,
      );
      let used = entries.reduce((sum, entry) => sum + entry.bytes, 0);
      for (const entry of entries.sort((a, b) => a.modified - b.modified)) {
        if (used + input.data.byteLength <= budget) break;
        if (entry.modified > now - PROTECTED_AGE_MS) continue;
        // Recheck the path immediately before deletion; never follow a link out of the store.
        const resolved = yield* fs.realPath(entry.file).pipe(Effect.option);
        if (Option.isNone(resolved) || resolved.value !== entry.file) continue;
        const removed = yield* fs.remove(entry.file).pipe(Effect.result);
        if (removed._tag === "Success") used -= entry.bytes;
      }
      if (used + input.data.byteLength > budget)
        return yield* new BrowserArtifactBudgetError({ reason: "capacity" });
      const destination = path.join(directory, input.fileName);
      yield* fs.writeFile(destination, input.data, { flag: "wx" });
      return destination;
    }),
  );
});

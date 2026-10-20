import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { YaziPickerError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as YaziPicker from "./YaziPicker.ts";

class FakePty implements PtyAdapter.PtyProcess {
  readonly pid = 123;
  readonly writes: string[] = [];
  readonly sizes: Array<[number, number]> = [];
  killed = false;
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
  write(data: string) {
    this.writes.push(data);
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows]);
  }
  kill() {
    this.killed = true;
  }
  onData(listener: (data: string) => void) {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void) {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  emit(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exitCode = 0) {
    for (const listener of this.exitListeners) listener({ exitCode, signal: null });
  }
}

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-yazi-test-" });
  const process = new FakePty();
  const spawns: PtyAdapter.PtySpawnInput[] = [];
  const adapter = PtyAdapter.PtyAdapter.of({
    spawn: (input) =>
      Effect.sync(() => {
        spawns.push(input);
        return process;
      }),
  });
  const pickerLayer = YaziPicker.layer.pipe(
    Layer.provide(Layer.succeed(PtyAdapter.PtyAdapter, adapter)),
    Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
  );
  return { fs, path, home, process, spawns, pickerLayer };
});

it.effect(
  "runs the real chooser command from Home and transfers selected files in bounded chunks",
  () =>
    Effect.gen(function* () {
      const { fs, path, home, process, spawns, pickerLayer } = yield* setup;
      const firstPath = path.join(home, "report $(never-execute).txt");
      const secondPath = path.join(home, "photo.png");
      yield* fs.writeFile(firstPath, new Uint8Array(300_000).fill(42));
      yield* fs.writeFile(secondPath, new Uint8Array([137, 80, 78, 71]));
      yield* Effect.gen(function* () {
        const picker = yield* YaziPicker.YaziPicker;
        const opened = yield* picker.open("owner", { cols: 100, rows: 30 });
        assert.strictEqual(opened.homePath, home);
        const spawn = spawns[0]!;
        assert.strictEqual(spawn.shell, "yazi");
        assert.deepStrictEqual(spawn.args?.slice(0, 2), [home, "--chooser-file"]);
        assert.strictEqual(spawn.cwd, home);
        const chooserPath = spawn.args![2]!;
        process.emit("terminal output");
        const running = yield* picker.poll("owner", opened);
        assert.strictEqual(running.state, "running");
        assert.strictEqual(running.output, "terminal output");
        yield* fs.writeFileString(chooserPath, `${firstPath}\n${secondPath}\n`);
        process.exit();
        const selected = yield* picker.poll("owner", opened);
        assert.strictEqual(selected.output, "");
        assert.strictEqual(selected.state, "completed");
        assert.deepStrictEqual(
          selected.files.map((file) => file.name),
          [path.basename(firstPath), "photo.png"],
        );
        assert.strictEqual(selected.files[1]!.mimeType, "image/png");
        const fileId = selected.files[0]!.id;
        const first = yield* picker.read("owner", { ...opened, fileId, offset: 0 });
        assert.strictEqual(Buffer.from(first.dataBase64, "base64").length, 256 * 1024);
        assert.strictEqual(first.eof, false);
        const second = yield* picker.read("owner", { ...opened, fileId, offset: 256 * 1024 });
        assert.strictEqual(Buffer.from(second.dataBase64, "base64").length, 300_000 - 256 * 1024);
        assert.strictEqual(second.eof, true);
        yield* picker.close("owner", opened);
        assert.strictEqual(yield* fs.exists(path.dirname(chooserPath)), false);
      }).pipe(Effect.provide(pickerLayer));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps another auth session out of terminal input and selected file bytes", () =>
  Effect.gen(function* () {
    const { process, pickerLayer } = yield* setup;
    yield* Effect.gen(function* () {
      const picker = yield* YaziPicker.YaziPicker;
      const opened = yield* picker.open("owner", { cols: 80, rows: 24 });
      for (const operation of [
        picker.poll("other", opened),
        picker.write("other", { ...opened, data: "q" }),
        picker.read("other", { ...opened, fileId: "unknown", offset: 0 }),
        picker.close("other", opened),
      ]) {
        const error = yield* operation.pipe(Effect.flip);
        assert.instanceOf(error, YaziPickerError);
        assert.strictEqual(error.reason, "session");
      }
      assert.deepStrictEqual(process.writes, []);
      assert.strictEqual(process.killed, false);
      yield* picker.write("owner", { ...opened, data: "j" });
      yield* picker.resize("owner", { ...opened, cols: 120, rows: 40 });
      assert.deepStrictEqual(process.writes, ["j"]);
      assert.deepStrictEqual(process.sizes, [[120, 40]]);
      yield* picker.close("owner", opened);
      assert.strictEqual(process.killed, true);
    }).pipe(Effect.provide(pickerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("cancels cleanly and rejects directories instead of attaching paths", () =>
  Effect.gen(function* () {
    const { fs, home, process, spawns, pickerLayer } = yield* setup;
    yield* Effect.gen(function* () {
      const picker = yield* YaziPicker.YaziPicker;
      const cancelled = yield* picker.open("owner", { cols: 80, rows: 24 });
      process.exit();
      assert.strictEqual((yield* picker.poll("owner", cancelled)).state, "cancelled");
      yield* picker.close("owner", cancelled);
      const selected = yield* picker.open("owner", { cols: 80, rows: 24 });
      yield* fs.writeFileString(spawns[1]!.args![2]!, home + "\n");
      process.exit();
      const result = yield* picker.poll("owner", selected);
      assert.strictEqual(result.state, "failed");
      assert.deepStrictEqual(result.files, []);
      assert.isDefined(result.error);
    }).pipe(Effect.provide(pickerLayer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

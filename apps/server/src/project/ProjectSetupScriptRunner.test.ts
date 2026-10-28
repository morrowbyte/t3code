import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type ProjectScript,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { vi } from "vite-plus/test";
import * as ServerSettings from "../serverSettings.ts";
import * as StoragePressure from "../storagePressure.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const script: ProjectScript = {
  id: "install",
  name: "Install",
  command: "vp i --frozen-lockfile",
  icon: "configure",
  runOnWorktreeCreate: true,
  runOnSettle: true,
};

function runner() {
  const opened: TerminalOpenInput[] = [];
  const written: TerminalWriteInput[] = [];
  const layer = Layer.mergeAll(
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(TerminalManager.TerminalManager)({
      open: (input) =>
        Effect.sync(() => {
          opened.push(input);
          return {
            threadId: input.threadId,
            terminalId: input.terminalId ?? "default",
            cwd: input.cwd,
            worktreePath: input.worktreePath ?? null,
            status: "running" as const,
            pid: 1,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "",
            updatedAt: "2026-10-28T00:00:00Z",
          };
        }),
      write: (input) =>
        Effect.sync(() => {
          written.push(input);
        }),
    }),
    ServerSettings.layerTest(),
    NodeServices.layer,
  );
  return { opened, written, make: ProjectSetupScriptRunner.make.pipe(Effect.provide(layer)) };
}

function input(scripts: readonly ProjectScript[] = [script]) {
  return {
    threadId: "thread-storage",
    worktreePath: "/worktrees/feature",
    project: { id: ProjectId.make("project-storage"), workspaceRoot: "/repository", scripts },
  };
}

describe("ProjectSetupScriptRunner storage admission", () => {
  it.effect("refuses setup before opening a terminal or sending the script", () =>
    Effect.gen(function* () {
      const message = "Btrfs metadata is critically full. Free disk space and try again.";
      using admission = vi
        .spyOn(StoragePressure, "checkStorageAdmission")
        .mockResolvedValue(message);
      const test = runner();
      const service = yield* test.make;
      const result = yield* Effect.result(service.runForThread(input()));
      expect(test.opened).toEqual([]);
      expect(test.written).toEqual([]);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.message).toContain(message);
      expect(admission.mock.calls).toEqual([[["/repository", "/worktrees/feature"]]]);
    }),
  );

  it.effect("keeps setup execution unchanged when admission succeeds", () =>
    Effect.gen(function* () {
      using admission = vi.spyOn(StoragePressure, "checkStorageAdmission").mockResolvedValue(null);
      const test = runner();
      const service = yield* test.make;
      const result = yield* service.runForThread(input());
      expect(result).toMatchObject({
        status: "started",
        terminalId: "setup-install",
        scriptCommand: script.command,
      });
      expect(test.opened).toHaveLength(1);
      expect(test.opened[0]).toMatchObject({
        cwd: "/worktrees/feature",
        env: { T3CODE_PROJECT_ROOT: "/repository", T3CODE_WORKTREE_PATH: "/worktrees/feature" },
      });
      expect(test.written).toEqual([
        { threadId: "thread-storage", terminalId: "setup-install", data: ` ${script.command}\r` },
      ]);
      expect(admission).toHaveBeenCalledOnce();
    }),
  );

  it.effect("allows settle scripts and no-script resolution while storage is blocked", () =>
    Effect.gen(function* () {
      using admission = vi
        .spyOn(StoragePressure, "checkStorageAdmission")
        .mockResolvedValue("Storage full");
      const test = runner();
      const service = yield* test.make;
      expect(yield* service.runForThread(input([]))).toEqual({ status: "no-script" });
      expect(yield* service.runForThread({ ...input(), trigger: "settle" })).toMatchObject({
        status: "started",
      });
      expect(test.opened).toHaveLength(1);
      expect(test.written).toHaveLength(1);
      expect(admission).not.toHaveBeenCalled();
    }),
  );
});

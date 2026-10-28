import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as NodeZlib from "node:zlib";

import * as ProcessRunner from "../processRunner.ts";
import * as Executor from "./PrivilegedCommandExecutor.ts";

const input = {
  requestId: "one",
  script: "printf '%s\\n' '\"; $(touch /tmp/nope)'\nexit 7\n",
  shell: "sh" as const,
  cwd: "/",
  timeoutMs: 1000,
};
const output: ProcessRunner.ProcessRunOutput = {
  stdout: "output",
  stderr: "error",
  code: 7 as ProcessRunner.ProcessRunOutput["code"],
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
};
const linuxFs = FileSystem.makeNoop({
  realPath: (value) => Effect.succeed(value),
  makeTempDirectoryScoped: () => Effect.succeed("/fake-control"),
  writeFileString: () => Effect.void,
  exists: (name) => Effect.succeed(name.endsWith("cgroup.controllers")),
  readFileString: () => Effect.succeed(`1 (node) S ${"0 ".repeat(18)}123`),
  stat: (value) =>
    Effect.succeed({
      type: value.startsWith("/trusted/") || value === "/bin/sh" ? "File" : "Directory",
      uid: Option.some(0),
      mode: 0o755,
    } as FileSystem.File.Info),
});
const linuxRunner = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  ProcessRunner.ProcessRunner.of({
    run: (call) => {
      if (call.args[0] === "--version")
        return Effect.succeed({
          ...output,
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout: "systemd 260\n",
        });
      if (call.command === "/trusted/python3")
        return Effect.succeed({
          ...output,
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout: "",
        });
      return run(call);
    },
  });
const windowsRunner = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
  ProcessRunner.ProcessRunner.of({
    run: (call) =>
      call.args.at(-1) === "-"
        ? run(call)
        : Effect.succeed({
            ...output,
            code: 0 as ProcessRunner.ProcessRunOutput["code"],
            stdout: "133444555000000000",
          }),
  });

describe("PrivilegedCommandExecutor", () => {
  it.effect("passes the exact approved script on stdin and reports the exit status", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const runner = linuxRunner((call) => {
      calls.push(call);
      const receipt = `\nT3_RESULT_${call.args.at(-5)}:done:7\n`;
      call.onStdoutChunk?.(Buffer.from(`output${receipt}`));
      return Effect.succeed({ ...output, stdout: `output${receipt}` });
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      const result = yield* service.execute(input);
      expect(result).toEqual({
        status: "failed",
        exitCode: 7,
        stdout: "output",
        stderr: "error",
        cleanupConfirmed: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "/bin/sh",
        stdin: input.script,
        cwd: "/",
        timeout: 21000,
      });
      expect(calls[0]!.args).toContain("/trusted/systemd-run");
      expect(calls[0]!.args).toContain("6000ms");
      expect(calls[0]!.args.join(" ")).not.toContain(input.script);
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("reports a supervisor stop after the unit has finished", () => {
    const runner = linuxRunner((call) => {
      const receipt = `\nT3_RESULT_${call.args.at(-5)}:stop:124\n`;
      call.onStdoutChunk?.(Buffer.from(receipt));
      return Effect.succeed({
        ...output,
        stdout: receipt,
        code: 124 as ProcessRunner.ProcessRunOutput["code"],
      });
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect((yield* service.execute(input)).status).toBe("cancelled");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect(
    "returns unknown without a cleanup receipt when the runner cannot prove completion",
    () => {
      const runner = linuxRunner(() => Effect.succeed(output));
      return Effect.gen(function* () {
        const service = yield* Executor.PrivilegedCommandExecutor;
        const result = yield* service.execute(input);
        expect(result.status).toBe("unknown");
        expect(result.cleanupConfirmed).toBeUndefined();
        expect(result.stderr).toContain("error");
      }).pipe(
        Effect.provide(Executor.layer),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
        Effect.provideService(FileSystem.FileSystem, linuxFs),
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("confirms a sudo preflight rejection but not a forged worker message", () => {
    let calls = 0;
    const runner = linuxRunner((call) => {
      calls++;
      const receipt = call.args.at(-5)!;
      const denied = `T3_PREFLIGHT_${receipt}:denied\n`;
      const allowed = `T3_PREFLIGHT_${receipt}:allowed\n`;
      return Effect.succeed({
        ...output,
        code: 125 as ProcessRunner.ProcessRunOutput["code"],
        stdout: calls === 1 ? denied : allowed + denied,
        stderr: "sudo: a password is required",
      });
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      const rejected = yield* service.execute(input);
      expect(rejected.status).toBe("failed");
      expect(rejected.cleanupConfirmed).toBe(true);
      expect(rejected.stderr).toContain("sudo");
      const forged = yield* service.execute(input);
      expect(forged.status).toBe("unknown");
      expect(forged.cleanupConfirmed).toBeUndefined();
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("keeps interruption pending until the supervisor and unit confirm cleanup", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const stopWritten = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const fs = FileSystem.makeNoop({
        ...linuxFs,
        writeFileString: (name) =>
          name.endsWith(".stop")
            ? Deferred.succeed(stopWritten, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const runner = linuxRunner((call) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
          const receipt = `\nT3_RESULT_${call.args.at(-5)}:stop:124\n`;
          call.onStdoutChunk?.(Buffer.from(receipt));
          return {
            ...output,
            stdout: receipt,
            code: 124 as ProcessRunner.ProcessRunOutput["code"],
          };
        }),
      );
      const task = Effect.gen(function* () {
        const service = yield* Executor.PrivilegedCommandExecutor;
        const running = yield* service.execute(input).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const interruption = yield* Fiber.interrupt(running).pipe(
          Effect.tap(() => Deferred.succeed(interrupted, undefined)),
          Effect.forkChild,
        );
        yield* Deferred.await(stopWritten);
        expect(yield* Deferred.isDone(interrupted)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(interruption);
      });
      yield* task.pipe(
        Effect.provide(Executor.layer),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(NodeServices.layer),
      );
    }),
  );

  it.effect("recovery never treats an absent Linux unit as confirmed", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (call) => {
        calls.push(call);
        return Effect.succeed({
          ...output,
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout: "LoadState=not-found\nActiveState=inactive\nControlGroup=\n",
        });
      },
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect(yield* service.cleanup({ requestId: input.requestId, shell: "sh" })).toEqual({
        status: "unknown",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).not.toContain("stop");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect(
    "recovery confirms a changed Linux boot but not a missing unit in the same boot",
    () => {
      const bootId = "11111111-1111-1111-1111-111111111111";
      const fs = FileSystem.makeNoop({
        ...linuxFs,
        readFileString: (name) =>
          Effect.succeed(
            name.endsWith("boot_id") ? `${bootId}\n` : `1 (node) S ${"0 ".repeat(18)}123`,
          ),
      });
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.succeed({
            ...output,
            code: 0 as ProcessRunner.ProcessRunOutput["code"],
            stdout: "LoadState=not-found\nActiveState=inactive\nControlGroup=\n",
          }),
      });
      return Effect.gen(function* () {
        const service = yield* Executor.PrivilegedCommandExecutor;
        expect(yield* service.captureRecoveryIdentity()).toEqual({
          platform: "linux",
          bootId,
          processId: process.pid,
          processStart: "123",
        });
        expect(
          yield* service.cleanup({
            requestId: input.requestId,
            shell: "sh",
            identity: { platform: "linux", bootId: "22222222-2222-2222-2222-222222222222" },
          }),
        ).toEqual({ status: "confirmed" });
        expect(
          yield* service.cleanup({
            requestId: input.requestId,
            shell: "sh",
            identity: { platform: "linux", bootId },
          }),
        ).toEqual({ status: "unknown" });
        expect(
          yield* service.cleanup({
            requestId: input.requestId,
            shell: "sh",
            identity: { platform: "linux", bootId, processId: process.pid, processStart: "123" },
          }),
        ).toEqual({ status: "unknown" });
        expect(
          yield* service.cleanup({
            requestId: input.requestId,
            shell: "sh",
            identity: { platform: "linux", bootId, processId: 999999, processStart: "456" },
          }),
        ).toEqual({ status: "unknown" });
      }).pipe(
        Effect.provide(Executor.layer),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("recovery confirms a stopped unit only when its cgroup is empty", () => {
    let showCount = 0;
    let stoppedUnit = "";
    const fs = FileSystem.makeNoop({
      ...linuxFs,
      exists: () => Effect.succeed(true),
      readFileString: () => Effect.succeed("populated 0\nfrozen 0\n"),
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: (call) => {
        if (call.command === "/trusted/sudo") {
          stoppedUnit = call.args.at(-1)!;
          return Effect.succeed({ ...output, code: 0 as ProcessRunner.ProcessRunOutput["code"] });
        }
        const unit = call.args[2]!;
        showCount++;
        return Effect.succeed({
          ...output,
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout:
            showCount === 1
              ? `LoadState=loaded\nActiveState=active\nControlGroup=/system.slice/${unit}\n`
              : "LoadState=not-found\nActiveState=inactive\nControlGroup=\n",
        });
      },
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect(yield* service.cleanup({ requestId: input.requestId, shell: "sh" })).toEqual({
        status: "confirmed",
      });
      expect(stoppedUnit).toMatch(/^t3-privileged-[0-9a-f]{64}\.service$/);
      expect(showCount).toBe(2);
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("Windows recovery requires a different observed boot identity", () => {
    const runner = ProcessRunner.ProcessRunner.of({
      run: () =>
        Effect.succeed({
          ...output,
          code: 0 as ProcessRunner.ProcessRunOutput["code"],
          stdout: "12:133444555000000000",
        }),
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect(yield* service.captureRecoveryIdentity()).toEqual({
        platform: "win32",
        bootId: "12",
        processId: process.pid,
        processStart: "133444555000000000",
      });
      expect(
        yield* service.cleanup({
          requestId: input.requestId,
          shell: "powershell",
          identity: { platform: "win32", bootId: "11" },
        }),
      ).toEqual({ status: "confirmed" });
      expect(
        yield* service.cleanup({
          requestId: input.requestId,
          shell: "powershell",
          identity: { platform: "win32", bootId: "12" },
        }),
      ).toEqual({ status: "unknown" });
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("reports a sudo spawn failure without claiming execution", () => {
    const runner = linuxRunner(() =>
      Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: "sudo",
          argumentCount: 3,
          cause: "ENOENT",
        }),
      ),
    );
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect(yield* service.execute(input)).toEqual({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: "Could not start the privileged command wrapper.",
        cleanupConfirmed: true,
      });
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("passes the approved Windows payload to the wrapper and decodes bounded output", () => {
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const runner = windowsRunner((call) => {
      calls.push(call);
      return Effect.succeed({
        ...output,
        code: 0 as ProcessRunner.ProcessRunOutput["code"],
        stdout: `failed\n7\n${Buffer.from("Grüße").toString("base64")}\nZXJy:truncated`,
        stderr: "",
      });
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      const result = yield* service.execute({ ...input, shell: "powershell" });
      expect(result).toEqual({
        status: "failed",
        exitCode: 7,
        stdout: "Grüße",
        stderr: "err\n[output truncated]",
        cleanupConfirmed: true,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
        timeout: 21000,
      });
      expect(calls[0]!.args.join(" ")).not.toContain(input.script);
      const encoded = /FromBase64String\('([^']+)'\)/.exec(calls[0]!.stdin!)![1]!;
      const wrapper = Buffer.from(encoded, "base64").toString("utf8");
      expect(wrapper).toContain(
        NodeZlib.gzipSync(Buffer.from(input.script, "utf16le")).toString("base64"),
      );
      expect(wrapper).toContain("-Verb RunAs");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("reports a rejected UAC prompt as cancelled", () => {
    const runner = windowsRunner(() =>
      Effect.succeed({
        ...output,
        code: 0 as ProcessRunner.ProcessRunOutput["code"],
        stdout: "UAC_CANCELLED",
        stderr: "",
      }),
    );
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect((yield* service.execute({ ...input, shell: "powershell" })).status).toBe("cancelled");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect(
    "preflight rejects a payload that exceeds the Windows command line before requesting elevation",
    () => {
      const runner = ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected spawn") });
      return Effect.gen(function* () {
        const service = yield* Executor.PrivilegedCommandExecutor;
        yield* service.validate({ ...input, shell: "powershell" });
        const error = yield* Effect.flip(
          service.validate({ ...input, shell: "powershell", script: "x".repeat(12000) }),
        );
        expect(error.reason).toBe("invalid-input");
      }).pipe(
        Effect.provide(Executor.layer),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, { SystemRoot: "C:\\Windows" }),
        Effect.provide(NodeServices.layer),
      );
    },
  );

  it.effect("reports missing Linux prerequisites without requesting elevation", () => {
    const runner = ProcessRunner.ProcessRunner.of({ run: () => Effect.die("unexpected spawn") });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      const error = yield* Effect.flip(service.validate(input));
      expect(error.reason).toBe("linux-prerequisites");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });

  it.effect("preflight rejects an unsupported systemd version or missing pidfd", () => {
    let missingPidfd = false;
    const runner = ProcessRunner.ProcessRunner.of({
      run: (call) =>
        Effect.succeed({
          ...output,
          code: (missingPidfd && call.command === "/trusted/python3"
            ? 1
            : 0) as ProcessRunner.ProcessRunOutput["code"],
          stdout:
            call.args[0] === "--version" ? (missingPidfd ? "systemd 260" : "systemd 253") : "",
        }),
    });
    return Effect.gen(function* () {
      const service = yield* Executor.PrivilegedCommandExecutor;
      expect((yield* Effect.flip(service.validate(input))).reason).toBe("linux-prerequisites");
      missingPidfd = true;
      expect((yield* Effect.flip(service.validate(input))).reason).toBe("linux-prerequisites");
    }).pipe(
      Effect.provide(Executor.layer),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: "/trusted" }),
      Effect.provideService(FileSystem.FileSystem, linuxFs),
      Effect.provide(NodeServices.layer),
    );
  });
});

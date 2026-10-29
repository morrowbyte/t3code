import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import * as LinuxSupervisor from "./LinuxSupervisor.ts";
import { makeWindowsWrapper } from "./WindowsSupervisor.ts";

export interface PrivilegedCommandInput {
  readonly requestId: string;
  readonly script: string;
  readonly shell: "powershell" | "sh";
  readonly cwd: string;
  readonly timeoutMs: number;
}

export interface PrivilegedCommandResult {
  readonly status: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cleanupConfirmed?: true;
}

export interface PrivilegedRecoveryIdentity {
  readonly platform: "linux" | "win32";
  readonly bootId: string;
  readonly processId: number;
  readonly processStart: string;
}

export class PrivilegedCommandExecutionError extends Schema.TaggedError<PrivilegedCommandExecutionError>()(
  "PrivilegedCommandExecutionError",
  {
    reason: Schema.Literals([
      "unsupported",
      "invalid-input",
      "invalid-cwd",
      "linux-prerequisites",
      "control-unavailable",
    ]),
  },
) {
  // Every typed failure is raised before the privileged runner is spawned.
  get cleanupConfirmed(): true {
    return true;
  }
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Privileged execution is not available for this platform and shell.";
      case "invalid-input":
        return "Invalid privileged command input.";
      case "invalid-cwd":
        return "The privileged command requires an existing absolute local working directory.";
      case "linux-prerequisites":
        return "Linux privileged execution requires trusted sudo, systemd 254 or newer, and Python 3 with pidfd support.";
      case "control-unavailable":
        return "Could not establish the privileged execution stop channel.";
    }
  }
}

export class PrivilegedCommandExecutor extends Context.Service<
  PrivilegedCommandExecutor,
  {
    readonly validate: (
      input: PrivilegedCommandInput,
    ) => Effect.Effect<void, PrivilegedCommandExecutionError>;
    readonly captureRecoveryIdentity: () => Effect.Effect<
      PrivilegedRecoveryIdentity,
      PrivilegedCommandExecutionError
    >;
    readonly cleanup: (input: {
      readonly requestId: string;
      readonly shell: "powershell" | "sh";
      readonly identity?: Pick<PrivilegedRecoveryIdentity, "platform" | "bootId"> &
        Partial<Pick<PrivilegedRecoveryIdentity, "processId" | "processStart">>;
    }) => Effect.Effect<
      { readonly status: "confirmed" | "unknown" },
      PrivilegedCommandExecutionError
    >;
    readonly execute: (
      input: PrivilegedCommandInput,
    ) => Effect.Effect<PrivilegedCommandResult, PrivilegedCommandExecutionError>;
  }
>()("t3/privilegedCommands/PrivilegedCommandExecutor") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;

  const unitName = Effect.fn("PrivilegedCommandExecutor.unitName")(function* (requestId: string) {
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(requestId))
      .pipe(
        Effect.mapError(
          () => new PrivilegedCommandExecutionError({ reason: "control-unavailable" }),
        ),
      );
    return `t3-privileged-${Buffer.from(digest).toString("hex")}.service`;
  });

  // Only system-owned, non-user-writable executables and parent directories may be elevated.
  const trustedExecutable = Effect.fn("PrivilegedCommandExecutor.trustedExecutable")(function* (
    name: string,
  ) {
    const candidates = path.isAbsolute(name)
      ? [name]
      : (environment.PATH ?? "")
          .split(":")
          .filter(path.isAbsolute)
          .map((directory) => path.join(directory, name));
    for (const candidate of candidates) {
      const resolved = yield* fs.realPath(candidate).pipe(Effect.option);
      if (resolved._tag === "None") continue;
      let current = resolved.value;
      let executable = true;
      let trusted = true;
      while (true) {
        const info = yield* fs.stat(current).pipe(Effect.option);
        if (
          info._tag === "None" ||
          info.value.uid._tag !== "Some" ||
          info.value.uid.value !== 0 ||
          ((info.value.mode & 0o022) !== 0 && (executable || (info.value.mode & 0o1000) === 0)) ||
          (executable && (info.value.type !== "File" || (info.value.mode & 0o111) === 0)) ||
          (!executable && info.value.type !== "Directory")
        ) {
          trusted = false;
          break;
        }
        executable = false;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
      if (trusted) return resolved.value;
    }
    return null;
  });

  const prepare = Effect.fn("PrivilegedCommandExecutor.prepare")(function* (
    input: PrivilegedCommandInput,
  ) {
    if (
      !(
        (platform === "linux" && input.shell === "sh") ||
        (platform === "win32" && input.shell === "powershell")
      )
    ) {
      return yield* new PrivilegedCommandExecutionError({ reason: "unsupported" });
    }
    if (
      !Number.isSafeInteger(input.timeoutMs) ||
      input.timeoutMs <= 0 ||
      input.timeoutMs > 2147483647 ||
      input.script.includes("\0") ||
      !input.script.isWellFormed() ||
      !input.cwd.isWellFormed()
    ) {
      return yield* new PrivilegedCommandExecutionError({ reason: "invalid-input" });
    }
    if (!path.isAbsolute(input.cwd) || input.cwd.startsWith("//") || input.cwd.startsWith("\\\\")) {
      return yield* new PrivilegedCommandExecutionError({ reason: "invalid-cwd" });
    }
    const stat = yield* fs.stat(input.cwd).pipe(Effect.option);
    if (stat._tag === "None" || stat.value.type !== "Directory") {
      return yield* new PrivilegedCommandExecutionError({ reason: "invalid-cwd" });
    }
    if (
      platform === "win32" &&
      makeWindowsWrapper(
        input.script,
        input.cwd,
        input.timeoutMs,
        "x".repeat(1024),
        2147483647,
        "9999999999999999999",
      ) === null
    ) {
      return yield* new PrivilegedCommandExecutionError({ reason: "invalid-input" });
    }
    if (platform === "linux" && Buffer.byteLength(input.script, "utf8") > 262144) {
      return yield* new PrivilegedCommandExecutionError({ reason: "invalid-input" });
    }
    if (platform !== "linux") return null;
    const [sudo, systemdRun, python, shell] = yield* Effect.all([
      trustedExecutable("sudo"),
      trustedExecutable("systemd-run"),
      trustedExecutable("python3"),
      trustedExecutable("/bin/sh"),
    ]);
    const systemd = yield* fs.stat("/run/systemd/system").pipe(Effect.option);
    if (
      !sudo ||
      !systemdRun ||
      !python ||
      !shell ||
      systemd._tag === "None" ||
      systemd.value.type !== "Directory"
    ) {
      return yield* new PrivilegedCommandExecutionError({ reason: "linux-prerequisites" });
    }
    // These probes are unprivileged and do not request sudo or start a systemd unit.
    const [version, pidfd] = yield* Effect.all([
      runner
        .run({ command: systemdRun, args: ["--version"], timeout: 5000, maxOutputBytes: 4096 })
        .pipe(Effect.option),
      runner
        .run({
          command: python,
          args: [
            "-I",
            "-c",
            "import os,select; assert hasattr(os,'waitid') and hasattr(os,'WNOWAIT') and hasattr(select,'poll'); os.close(os.pidfd_open(os.getpid(),0))",
          ],
          timeout: 5000,
          maxOutputBytes: 4096,
        })
        .pipe(Effect.option),
    ]);
    const versionMatch =
      version._tag === "Some" && version.value.code === 0
        ? /^systemd\s+(\d+)/.exec(version.value.stdout)
        : null;
    if (
      !versionMatch ||
      Number(versionMatch[1]) < 254 ||
      pidfd._tag === "None" ||
      pidfd.value.code !== 0
    ) {
      return yield* new PrivilegedCommandExecutionError({ reason: "linux-prerequisites" });
    }
    return { sudo, systemdRun, python, shell };
  });

  const validate: PrivilegedCommandExecutor["Service"]["validate"] = Effect.fn(
    "PrivilegedCommandExecutor.validate",
  )(function* (input) {
    yield* prepare(input);
  });

  const readLinuxStart = Effect.fn("PrivilegedCommandExecutor.readLinuxStart")(function* (
    pid: number,
  ) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option);
    if (stat._tag === "None") return null;
    const index = stat.value.lastIndexOf(") ");
    const start =
      index < 0
        ? ""
        : (stat.value
            .slice(index + 2)
            .trim()
            .split(/\s+/)[19] ?? "");
    return /^\d+$/.test(start) ? start : null;
  });

  const captureRecoveryIdentity: PrivilegedCommandExecutor["Service"]["captureRecoveryIdentity"] =
    Effect.fn("PrivilegedCommandExecutor.captureRecoveryIdentity")(function* () {
      if (platform === "linux") {
        const value = yield* fs
          .readFileString("/proc/sys/kernel/random/boot_id")
          .pipe(Effect.option);
        const bootId = value._tag === "Some" ? value.value.trim().toLowerCase() : "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) {
          return yield* new PrivilegedCommandExecutionError({ reason: "control-unavailable" });
        }
        const processStart = yield* readLinuxStart(process.pid);
        if (processStart === null)
          return yield* new PrivilegedCommandExecutionError({ reason: "control-unavailable" });
        return { platform: "linux" as const, bootId, processId: process.pid, processStart };
      }
      if (platform === "win32") {
        const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
        if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot))
          return yield* new PrivilegedCommandExecutionError({ reason: "control-unavailable" });
        // ProcessTelemetryIdInformation exposes the OS boot sequence; no UAC is requested.
        const script = String.raw`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class T3Boot { [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr p,int c,IntPtr b,int n,out int r); public static uint Read() { IntPtr b=Marshal.AllocHGlobal(4096); try { int n; int status=NtQueryInformationProcess(new IntPtr(-1),64,b,4096,out n); if(status<0 || n<64 || Marshal.ReadInt32(b,0)<64) throw new Exception("boot identity unavailable"); return unchecked((uint)Marshal.ReadInt32(b,60)); } finally { Marshal.FreeHGlobal(b); } } }'; [Console]::Out.Write(([T3Boot]::Read().ToString()+':' + (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc().ToString()))`;
        const value = yield* runner
          .run({
            command: `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
            args: [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-EncodedCommand",
              Buffer.from(script, "utf16le").toString("base64"),
            ],
            timeout: 5000,
            maxOutputBytes: 4096,
          })
          .pipe(Effect.option);
        const raw =
          value._tag === "Some" && value.value.code === 0 ? value.value.stdout.trim() : "";
        const match = /^(\d{1,10}):(\d{1,19})$/.exec(raw);
        if (!match || Number(match[1]) > 0xffffffff)
          return yield* new PrivilegedCommandExecutionError({ reason: "control-unavailable" });
        return {
          platform: "win32" as const,
          bootId: match[1]!,
          processId: process.pid,
          processStart: match[2]!,
        };
      }
      return yield* new PrivilegedCommandExecutionError({ reason: "unsupported" });
    });

  const cleanup: PrivilegedCommandExecutor["Service"]["cleanup"] = Effect.fn(
    "PrivilegedCommandExecutor.cleanup",
  )(function* (input) {
    const unknown = { status: "unknown" as const };
    if (
      input.identity &&
      input.identity.platform === platform &&
      ((platform === "linux" && input.shell === "sh") ||
        (platform === "win32" && input.shell === "powershell"))
    ) {
      const valid =
        input.identity.platform === "linux"
          ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
              input.identity.bootId,
            )
          : /^\d{1,10}$/.test(input.identity.bootId) && Number(input.identity.bootId) <= 0xffffffff;
      if (valid) {
        const now = yield* captureRecoveryIdentity().pipe(Effect.option);
        if (
          now._tag === "Some" &&
          now.value.platform === input.identity.platform &&
          now.value.bootId !== input.identity.bootId
        )
          return { status: "confirmed" as const };
      }
    }
    if (platform !== "linux" || input.shell !== "sh") return unknown;
    const cgroupV2 = yield* fs.exists("/sys/fs/cgroup/cgroup.controllers").pipe(Effect.option);
    if (cgroupV2._tag === "None" || !cgroupV2.value) return unknown;
    const [sudo, systemctl] = yield* Effect.all([
      trustedExecutable("sudo"),
      trustedExecutable("systemctl"),
    ]);
    if (!sudo || !systemctl) return unknown;
    const unit = yield* unitName(input.requestId);
    const show = () =>
      runner
        .run({
          command: systemctl,
          args: [
            "--no-ask-password",
            "show",
            unit,
            "--property=LoadState",
            "--property=ActiveState",
            "--property=ControlGroup",
          ],
          timeout: 10000,
          maxOutputBytes: 4096,
        })
        .pipe(Effect.option);
    const before = yield* show();
    if (before._tag === "None" || before.value.code !== 0) return unknown;
    const fields = Object.fromEntries(
      before.value.stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => {
          const pos = line.indexOf("=");
          return [line.slice(0, pos), line.slice(pos + 1)];
        }),
    );
    const group = `/system.slice/${unit}`;
    // A missing unit cannot exclude an already submitted but still pending systemd-run.
    // The supervisor rejects a dead server, but could itself start after this check.
    if (
      fields.LoadState !== "loaded" ||
      !["active", "activating", "deactivating"].includes(fields.ActiveState ?? "") ||
      fields.ControlGroup !== group
    )
      return unknown;
    // Cleanup may stop only this deterministic unit; it never starts an approved payload.
    const stopped = yield* runner
      .run({
        command: sudo,
        args: ["-n", "--", systemctl, "--no-ask-password", "stop", unit],
        timeout: 10000,
        maxOutputBytes: 4096,
      })
      .pipe(Effect.option);
    if (stopped._tag === "None" || stopped.value.code !== 0) return unknown;
    const after = yield* show();
    if (
      after._tag === "None" ||
      after.value.code !== 0 ||
      !/^ActiveState=(inactive|failed)$/m.test(after.value.stdout)
    )
      return unknown;
    const eventsPath = `/sys/fs/cgroup${group}/cgroup.events`;
    const exists = yield* fs.exists(eventsPath).pipe(Effect.option);
    if (exists._tag === "None") return unknown;
    if (exists.value) {
      const events = yield* fs.readFileString(eventsPath).pipe(Effect.option);
      if (events._tag === "None" || !/^populated 0$/m.test(events.value)) return unknown;
    }
    return { status: "confirmed" as const };
  });

  const guarded = Effect.fn("PrivilegedCommandExecutor.guarded")(function* (
    timeoutMs: number,
    run: (
      control: string,
    ) => Effect.Effect<{ result: PrivilegedCommandResult; confirmed: boolean }>,
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-privileged-" })
          .pipe(
            Effect.mapError(
              () => new PrivilegedCommandExecutionError({ reason: "control-unavailable" }),
            ),
          );
        const control = path.join(directory, "control");
        yield* fs
          .writeFileString(control, "run")
          .pipe(
            Effect.mapError(
              () => new PrivilegedCommandExecutionError({ reason: "control-unavailable" }),
            ),
          );
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // The detached runner must outlive the interrupted caller until systemd or the job is empty.
            const fiber = yield* run(control).pipe(Effect.forkDetach);
            const waitFinished = Fiber.await(fiber).pipe(
              Effect.map((exit): PrivilegedCommandResult => {
                if (Exit.isSuccess(exit))
                  return exit.value.confirmed
                    ? { ...exit.value.result, cleanupConfirmed: true }
                    : exit.value.result;
                return {
                  status: "unknown",
                  exitCode: null,
                  stdout: "",
                  stderr: "Execution could not be confirmed; do not retry automatically.",
                };
              }),
            );
            const waitConfirmed = Fiber.await(fiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit) && exit.value.confirmed
                  ? Effect.succeed({ ...exit.value.result, cleanupConfirmed: true as const })
                  : Effect.never,
              ),
            );
            const stop = fs.writeFileString(`${control}.stop`, "stop").pipe(Effect.ignore);
            const wait = waitFinished.pipe(
              Effect.map((result) => ({ kind: "done" as const, result })),
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () => Effect.succeed({ kind: "timeout" as const }),
              }),
              Effect.flatMap((result) =>
                result.kind === "done"
                  ? Effect.succeed(result.result)
                  : stop.pipe(Effect.andThen(waitFinished)),
              ),
            );
            return yield* restore(wait).pipe(
              Effect.onInterrupt(() => stop.pipe(Effect.andThen(waitConfirmed), Effect.asVoid)),
            );
          }),
        );
      }),
    );
  });

  const execute: PrivilegedCommandExecutor["Service"]["execute"] = Effect.fn(
    "PrivilegedCommandExecutor.execute",
  )(function* (input) {
    const linuxTools = yield* prepare(input);
    if (platform === "win32") {
      const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
      if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) {
        return yield* new PrivilegedCommandExecutionError({ reason: "unsupported" });
      }
      const powershell = `${systemRoot.replace(/[\\/]+$/, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
      // Capture the actual T3 process creation time before any elevation can be requested.
      const identity = yield* runner
        .run({
          command: powershell,
          args: [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `[Console]::Out.Write((Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().ToFileTimeUtc())`,
          ],
          timeout: 5000,
          maxOutputBytes: 4096,
        })
        .pipe(Effect.option);
      const serverCreation =
        identity._tag === "Some" && identity.value.code === 0 ? identity.value.stdout.trim() : "";
      if (!/^\d{1,19}$/.test(serverCreation)) {
        return {
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: "Could not establish the T3 process identity.",
          cleanupConfirmed: true,
        };
      }
      return yield* guarded(input.timeoutMs, (control) =>
        Effect.gen(function* () {
          const wrapper = makeWindowsWrapper(
            input.script,
            input.cwd,
            input.timeoutMs,
            control,
            process.pid,
            serverCreation,
          );
          if (wrapper === null)
            return {
              result: {
                status: "failed",
                exitCode: null,
                stdout: "",
                stderr: "The approved command does not fit the Windows command line.",
              },
              confirmed: true,
            };
          const stdin = `& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(wrapper).toString("base64")}'))))`;
          const invocation = yield* runner
            .run({
              command: powershell,
              args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"],
              cwd: input.cwd,
              stdin,
              timeout: input.timeoutMs + 20000,
              timeoutBehavior: "timedOutResult",
              maxOutputBytes: 192 * 1024,
              outputMode: "truncate",
            })
            .pipe(Effect.result);
          if (invocation._tag === "Failure" && invocation.failure._tag === "ProcessSpawnError") {
            return {
              result: {
                status: "failed",
                exitCode: null,
                stdout: "",
                stderr: "Could not start the privileged command wrapper.",
              },
              confirmed: true,
            };
          }
          if (
            invocation._tag === "Success" &&
            invocation.success.code === 0 &&
            !invocation.success.timedOut
          ) {
            const raw = invocation.success.stdout;
            if (raw === "UAC_CANCELLED")
              return {
                confirmed: true,
                result: {
                  status: "cancelled",
                  exitCode: null,
                  stdout: "",
                  stderr: "UAC approval was cancelled.",
                },
              };
            const match =
              /^(succeeded|failed|cancelled|unknown)\r?\n(\d*)\r?\n([A-Za-z0-9+/=]*(?::truncated)?)\r?\n([A-Za-z0-9+/=]*(?::truncated)?)$/.exec(
                raw,
              );
            if (match) {
              const status = match[1] as PrivilegedCommandResult["status"];
              const exitCode = match[2] === "" ? null : Number(match[2]);
              if (
                (status === "succeeded" && exitCode === 0) ||
                (status === "failed" &&
                  exitCode !== null &&
                  exitCode > 0 &&
                  exitCode <= 0xffffffff) ||
                ((status === "cancelled" || status === "unknown") && exitCode === null)
              ) {
                const decode = (value: string) => {
                  const truncated = value.endsWith(":truncated");
                  return (
                    Buffer.from(truncated ? value.slice(0, -10) : value, "base64").toString(
                      "utf8",
                    ) + (truncated ? "\n[output truncated]" : "")
                  );
                };
                return {
                  confirmed: true,
                  result: {
                    status,
                    exitCode,
                    stdout: decode(match[3]!),
                    stderr: decode(match[4]!),
                  },
                };
              }
            }
          }
          return {
            confirmed: false,
            result: {
              status: "unknown",
              exitCode: null,
              stdout: "",
              stderr: "Execution could not be confirmed; do not retry automatically.",
            },
          };
        }),
      );
    }
    if (linuxTools === null)
      return yield* new PrivilegedCommandExecutionError({ reason: "unsupported" });
    const { sudo, systemdRun, python, shell } = linuxTools;
    const serverStart = yield* readLinuxStart(process.pid);
    if (serverStart === null)
      return {
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: "Could not establish the T3 process identity.",
        cleanupConfirmed: true,
      };
    // The systemd runtime limit survives wrapper or supervisor death. Its cgroup also catches
    // descendants that leave the worker's process group. Never retry an ambiguous interruption.
    const receiptResult = yield* crypto.randomUUIDv4().pipe(Effect.option);
    if (receiptResult._tag === "None") {
      return {
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: "Could not initialize the supervisor receipt.",
        cleanupConfirmed: true as const,
      };
    }
    const receipt = receiptResult.value;
    const unit = yield* unitName(input.requestId);
    const receiptPattern = new RegExp(`\\nT3_RESULT_${receipt}:(done|stop):(\\d{1,3})\\n`);
    const preflightDenied = `T3_PREFLIGHT_${receipt}:denied\n`;
    const preflightAllowed = `T3_PREFLIGHT_${receipt}:allowed\n`;
    let observed = "";
    let reportedCode: number | null = null;
    let reportedStop = false;
    return yield* guarded(input.timeoutMs, (control) =>
      Effect.gen(function* () {
        const result = yield* runner
          .run({
            command: shell,
            args: [
              "-c",
              LinuxSupervisor.wrapper,
              "t3-privileged-wrapper",
              sudo,
              systemdRun,
              `${input.timeoutMs + 5000}ms`,
              input.cwd,
              python,
              LinuxSupervisor.supervisor,
              String(input.timeoutMs),
              shell,
              receipt,
              control,
              unit,
              String(process.pid),
              serverStart,
            ],
            cwd: input.cwd,
            stdin: input.script,
            timeout: input.timeoutMs + 20000,
            timeoutBehavior: "timedOutResult",
            maxOutputBytes: 64 * 1024,
            outputMode: "truncate",
            truncatedMarker: "\n[output truncated]",
            onStdoutChunk: (chunk) => {
              observed = (observed + Buffer.from(chunk).toString("latin1")).slice(-512);
              const match = receiptPattern.exec(observed);
              if (match) {
                reportedStop = match[1] === "stop";
                reportedCode = Number(match[2]);
              }
            },
          })
          .pipe(Effect.result);
        if (result._tag === "Failure" && result.failure._tag === "ProcessSpawnError") {
          return {
            confirmed: true,
            result: {
              status: "failed",
              exitCode: null,
              stdout: "",
              stderr: "Could not start the privileged command wrapper.",
            },
          };
        }
        if (
          result._tag === "Success" &&
          !result.success.timedOut &&
          result.success.code === 125 &&
          !result.success.stdoutTruncated &&
          result.success.stdout === preflightDenied
        ) {
          return {
            confirmed: true,
            result: {
              status: "failed",
              exitCode: null,
              stdout: "",
              stderr:
                "sudo could not authorize the command without a password; the privileged command was not started." +
                (result.success.stderr ? `\n${result.success.stderr}` : ""),
            },
          };
        }
        if (
          result._tag === "Failure" ||
          result.success.timedOut ||
          result.success.code === null ||
          reportedCode === null ||
          reportedCode !== result.success.code
        ) {
          return {
            confirmed: false,
            result: {
              status: "unknown",
              exitCode: null,
              stdout: "",
              stderr:
                (result._tag === "Success" && result.success.stderr
                  ? `${result.success.stderr}\n`
                  : "") + "Execution could not be confirmed; do not retry automatically.",
            },
          };
        }
        return {
          confirmed: true,
          result: {
            status: reportedStop ? "cancelled" : result.success.code === 0 ? "succeeded" : "failed",
            exitCode: reportedStop ? null : result.success.code,
            stdout: (result.success.stdout.startsWith(preflightAllowed)
              ? result.success.stdout.slice(preflightAllowed.length)
              : result.success.stdout
            ).replace(receiptPattern, ""),
            stderr: result.success.stderr,
          },
        };
      }),
    );
  });
  return PrivilegedCommandExecutor.of({ execute, validate, cleanup, captureRecoveryIdentity });
});

export const layer = Layer.effect(PrivilegedCommandExecutor, make);

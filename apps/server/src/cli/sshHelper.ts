// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDateInEffect:off
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  DESKTOP_BROWSER_REGISTRATION_FILE,
  DESKTOP_BROWSER_REGISTRATION_MAX_BYTES,
  DesktopBrowserRegistrationDescriptor,
  DesktopBrowserReady,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/cli";

import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const canBind = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });

// macOS permits this bind over a wildcard listener, so also check loopback connectivity.
const answersOnLoopback = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

const pickPort = Command.make("pick-port", {
  portFile: Argument.String("port-file"),
  defaultPort: Argument.Int("default-port"),
  scanWindow: Argument.Int("scan-window"),
}).pipe(
  Command.withHandler(({ portFile, defaultPort, scanWindow }) =>
    Effect.promise(async () => {
      const raw = NodeFS.existsSync(portFile) ? NodeFS.readFileSync(portFile, "utf8").trim() : "";
      const preferred = Number.parseInt(raw, 10);
      const start = Number.isInteger(preferred) ? preferred : defaultPort;
      for (let port = start; port < start + scanWindow; port += 1) {
        if ((await canBind(port)) && !(await answersOnLoopback(port))) {
          process.stdout.write(String(port));
          return;
        }
      }
      process.exitCode = 1;
    }),
  ),
);

const probe = (port: number, probeTimeoutMs: number) =>
  new Promise<boolean>((resolve) => {
    const request = NodeHttp.get(
      { hostname: "127.0.0.1", port, path: "/", timeout: probeTimeoutMs },
      (response) => {
        response.resume();
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          resolve(status >= 200 && status < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });

const waitReady = Command.make("wait-ready", {
  port: Argument.Int("port"),
  timeoutMs: Argument.Int("timeout-ms"),
  probeTimeoutMs: Argument.Int("probe-timeout-ms"),
}).pipe(
  Command.withHandler(({ port, timeoutMs, probeTimeoutMs }) =>
    Effect.promise(async () => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (await probe(port, probeTimeoutMs)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      process.exitCode = 1;
    }),
  ),
);

/** Prints `<pid> <port>` for a live default-home server, or exits 1. */
const runtimePort = Command.make("runtime-port", {
  runtimeFile: Argument.String("runtime-file"),
}).pipe(
  Command.withHandler(({ runtimeFile }) =>
    Effect.sync(() => {
      try {
        // @effect-diagnostics-next-line preferSchemaOverJson:off - mirrors the shell snippet's loose parse.
        const runtime = JSON.parse(NodeFS.readFileSync(runtimeFile, "utf8")) as {
          pid?: unknown;
          port?: unknown;
          origin?: unknown;
        };
        const pid = Number(runtime.pid);
        const port = Number(runtime.port);
        if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
          process.exitCode = 1;
          return;
        }
        const origin = new URL(String(runtime.origin ?? ""));
        if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
          process.exitCode = 1;
          return;
        }
        process.kill(pid, 0);
        process.stdout.write(`${pid} ${port}`);
      } catch {
        process.exitCode = 1;
      }
    }),
  ),
);

class DesktopBrowserHelperError extends Schema.TaggedError<DesktopBrowserHelperError>()(
  "DesktopBrowserHelperError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The running target browser channel could not be attached.";
  }
}

const decodeBrowserDescriptor = Schema.decodeUnknownSync(
  Schema.fromJsonString(DesktopBrowserRegistrationDescriptor),
);
const decodeBrowserReady = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopBrowserReady));

const connectDesktopBrowser = Effect.fn("sshHelper.connectDesktopBrowser")(function* (
  baseDir: string,
  environmentId: string,
) {
  const platform = yield* HostProcess.Platform;
  return yield* Effect.tryPromise({
    try: (signal) => {
      const descriptorPath = NodePath.join(baseDir, "userdata", DESKTOP_BROWSER_REGISTRATION_FILE);
      const fd = NodeFS.openSync(
        descriptorPath,
        NodeFS.constants.O_RDONLY |
          (NodeFS.constants.O_NOFOLLOW ?? 0) |
          (NodeFS.constants.O_NONBLOCK ?? 0),
      );
      let descriptor: DesktopBrowserRegistrationDescriptor;
      try {
        const stat = NodeFS.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.size > DESKTOP_BROWSER_REGISTRATION_MAX_BYTES ||
          (platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
        )
          throw new Error("The target channel descriptor is not private to this OS user.");
        if (NodeFS.lstatSync(descriptorPath).isSymbolicLink())
          throw new Error("The target channel descriptor must not be a symbolic link.");
        const bytes = Buffer.alloc(DESKTOP_BROWSER_REGISTRATION_MAX_BYTES + 1);
        const size = NodeFS.readSync(fd, bytes, 0, bytes.length, 0);
        if (size > DESKTOP_BROWSER_REGISTRATION_MAX_BYTES)
          throw new Error("The target channel descriptor exceeded its bound.");
        descriptor = decodeBrowserDescriptor(bytes.subarray(0, size).toString("utf8"));
      } finally {
        NodeFS.closeSync(fd);
      }
      if (descriptor.environmentId !== environmentId)
        throw new Error("The target environment changed.");
      process.kill(descriptor.processId, 0);
      if (platform !== "win32") {
        const stat = NodeFS.lstatSync(descriptor.endpoint);
        if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
          throw new Error("The target channel socket is not private to this OS user.");
      } else if (!descriptor.endpoint.startsWith("\\\\.\\pipe\\")) {
        throw new Error("The target channel is not an OS-local named pipe.");
      }
      return new Promise<void>((resolve, reject) => {
        const socket = NodeNet.createConnection(descriptor.endpoint);
        let settled = false;
        let ready = false;
        let header = Buffer.alloc(0);
        const timeout = setTimeout(
          () => finish(new Error("The target browser channel did not acknowledge registration.")),
          8_000,
        );
        const abort = () => finish(new Error("The target browser channel was cancelled."));
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          signal.removeEventListener("abort", abort);
          process.stdin.off("readable", checkCallerEof);
          process.stdin.off("end", callerEnded);
          process.stdin.off("close", callerEnded);
          process.stdin.off("error", callerFailed);
          process.stdout.off("close", callerEnded);
          process.stdout.off("error", callerFailed);
          socket.off("data", onHeader);
          process.stdin.unpipe(socket);
          process.stdin.pause();
          socket.unpipe(process.stdout);
          socket.destroy();
          if (error) reject(error);
          else resolve();
        };
        const checkCallerEof = () => {
          process.stdin.read(0);
        };
        const callerEnded = () => finish();
        const callerFailed = () => finish(new Error("The browser caller stream failed."));
        process.stdin.on("readable", checkCallerEof);
        process.stdin.once("end", callerEnded);
        process.stdin.once("close", callerEnded);
        process.stdin.once("error", callerFailed);
        process.stdout.once("close", callerEnded);
        process.stdout.once("error", callerFailed);
        signal.addEventListener("abort", abort, { once: true });
        socket.once("error", finish);
        socket.once("close", () =>
          finish(ready ? undefined : new Error("The target closed before registration.")),
        );
        socket.once("connect", () => {
          if (settled) return;
          if (signal.aborted) return abort();
          socket.write(
            `${JSON.stringify({
              type: "desktop-browser-register",
              environmentId,
              processEpoch: descriptor.processEpoch,
              token: descriptor.token,
            })}\n`,
          );
        });
        const onHeader = (chunk: Buffer) => {
          const end = chunk.indexOf(10);
          const prefix = end < 0 ? chunk : chunk.subarray(0, end);
          if (header.length + prefix.length > DESKTOP_BROWSER_REGISTRATION_MAX_BYTES)
            return finish(new Error("The target registration response exceeded its bound."));
          header = Buffer.concat([header, prefix]);
          if (end < 0) return;
          try {
            const response = decodeBrowserReady(header.toString("utf8"));
            if (
              response.environmentId !== environmentId ||
              response.processEpoch !== descriptor.processEpoch
            )
              throw new Error("The target process binding changed.");
            ready = true;
            clearTimeout(timeout);
            socket.off("data", onHeader);
            socket.pause();
            process.stdout.write(`${JSON.stringify(response)}\n`);
            const remaining = chunk.subarray(end + 1);
            if (remaining.length > 0) socket.unshift(remaining);
            socket.pipe(process.stdout, { end: false });
            process.stdin.off("readable", checkCallerEof);
            process.stdin.pipe(socket);
            socket.resume();
          } catch {
            finish(new Error("The target refused browser registration."));
          }
        };
        socket.on("data", onHeader);
        if (signal.aborted) abort();
        else if (process.stdin.readableEnded || process.stdin.destroyed || process.stdout.destroyed)
          callerEnded();
        else process.stdin.read(0);
      });
    },
    catch: () =>
      new DesktopBrowserHelperError({
        cause: new Error("The local browser capability is unavailable."),
      }),
  });
});

const desktopBrowser = Command.make("desktop-browser", {
  environmentId: Argument.String("environment-id"),
  baseDir: baseDirFlag,
}).pipe(
  Command.withHandler(({ environmentId, baseDir }) =>
    Effect.gen(function* () {
      const resolvedBaseDir = yield* resolveBaseDir(Option.getOrUndefined(baseDir));
      yield* connectDesktopBrowser(resolvedBaseDir, environmentId);
    }),
  ),
);

export const sshHelperCommand = Command.make("__ssh-helper").pipe(
  Command.unlisted,
  Command.withSubcommands([pickPort, waitReady, runtimePort, desktopBrowser]),
);

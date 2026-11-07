import {
  type DeviceHostSummary,
  DevicePlatformAvailability,
  DeviceToolVersions,
  deviceToolInstallMessage,
  type SshDeviceHostConfig,
} from "@t3tools/contracts";
import {
  runSshCommand,
  baseSshArgs,
  parseSshResolveOutput,
  resolveSshCommand,
} from "@t3tools/ssh/command";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as NetService from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Hex from "effect/encoding/Hex";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import { releaseAgentDeviceSession } from "./AgentDeviceTarget.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { makeDeviceHubOperations } from "./DeviceHubOperations.ts";
import { quoteRemoteArg, remoteDeviceEnvironment, remoteDeviceScript } from "./sshDeviceScript.ts";

const UNHEALTHY_PROBE_LIMIT = 3;

/** The host bootstrap failed on a host identified as Windows. */
export class SshWindowsHostError extends Schema.TaggedError<SshWindowsHostError>()(
  "SshWindowsHostError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Connected over SSH, but this host runs Windows, and SSH device hosts currently need macOS or Linux. To use this machine's devices, run T3 Code on it and connect to that environment.";
  }
}
export const isSshWindowsHostError = Schema.is(SshWindowsHostError);

const Probe = Schema.Struct({
  nodePath: Schema.String,
  tools: Schema.optional(DeviceToolVersions),
  platforms: Schema.Array(DevicePlatformAvailability),
});
const Started = Schema.Struct({
  ...Probe.fields,
  hubPort: Schema.Int,
  daemonPort: Schema.optionalKey(Schema.Int),
  token: Schema.optionalKey(Schema.String),
  entryPath: Schema.optionalKey(Schema.String),
  helpers: Schema.Struct({
    serveSimAxSettings: Schema.NullOr(Schema.String),
    serveSimCli: Schema.NullOr(Schema.String),
  }),
});
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(Probe));
const decodeStarted = Schema.decodeUnknownEffect(Schema.fromJsonString(Started));
const targetFor = (config: SshDeviceHostConfig, binding?: DeviceHost.DeviceSshBinding) => ({
  alias: binding?.hostname ?? config.target,
  hostname: binding?.hostname ?? config.target,
  username: binding?.username ?? null,
  port: binding?.port ?? config.port ?? null,
});
const identityArgs = (config: SshDeviceHostConfig, binding?: DeviceHost.DeviceSshBinding) =>
  binding
    ? [
        "-F",
        "none",
        "-i",
        binding.identityFile,
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "ForwardAgent=no",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${binding.knownHostsFile}`,
        "-o",
        "GlobalKnownHostsFile=none",
        "-o",
        `HostKeyAlias=${binding.hostKeyAlias}`,
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "ControlPersist=no",
      ]
    : config.identityFile
      ? ["-i", config.identityFile]
      : [];
const commandArgs = (script: string) => [
  "sh",
  "-c",
  quoteRemoteArg(remoteDeviceEnvironment + script),
];
const bootstrap = (
  config: SshDeviceHostConfig,
  owner: string,
  mode: "probe" | "start" | "agent-start" | "stop-agent" | "stop",
  binding?: DeviceHost.DeviceSshBinding,
) =>
  runSshCommand(targetFor(config, binding), {
    preHostArgs: identityArgs(config, binding),
    remoteCommandArgs: commandArgs(
      'command -v node >/dev/null 2>&1 || { echo "Node is missing from the non-interactive SSH PATH" >&2; exit 1; }; exec node',
    ),
    stdin: remoteDeviceScript(owner, mode),
    timeoutMs: mode === "start" || mode === "agent-start" ? 1_300_000 : 45_000,
  }).pipe(
    Effect.mapError(
      (cause) => new DeviceHost.DeviceHostError({ hostId: config.id, step: mode, cause }),
    ),
  );

const isSshCommandError = Schema.is(SshCommandError);

// cmd expands only %OS% and PowerShell only $env:OS; POSIX shells expand neither to Windows_NT.
const explainWindowsHost = Effect.fn("SshDeviceHost.explainWindowsHost")(function* (
  config: SshDeviceHostConfig,
  error: DeviceHost.DeviceHostError,
) {
  const cause = error.cause;
  // Windows ssh.exe preserves full remote exit statuses such as 9009.
  if (
    !isSshCommandError(cause) ||
    cause.exitCode === null ||
    cause.exitCode < 1 ||
    (cause.exitCode > 254 && cause.exitCode !== 9009)
  )
    return yield* error;
  let windows = yield* runSshCommand(targetFor(config), {
    preHostArgs: identityArgs(config),
    remoteCommandArgs: ["echo %OS% $env:OS"],
    timeoutMs: 15_000,
  }).pipe(
    Effect.map(({ stdout }) => /(?:^|\s)Windows_NT(?:\s|$)/u.test(stdout)),
    Effect.orElseSucceed(() => false),
  );
  if (!windows) {
    // Git Bash does not expand Windows shell variables, but its Node still reports win32.
    windows = yield* runSshCommand(targetFor(config), {
      preHostArgs: identityArgs(config),
      remoteCommandArgs: ["node", "-p", "process.platform"],
      timeoutMs: 15_000,
    }).pipe(
      Effect.map(({ stdout }) => stdout.trim() === "win32"),
      Effect.orElseSucceed(() => false),
    );
  }
  if (!windows) return yield* error;
  return yield* new DeviceHost.DeviceHostError({
    hostId: config.id,
    step: error.step,
    cause: new SshWindowsHostError({ cause }),
  });
});

const ownerFor = Effect.fn("SshDeviceHost.ownerFor")(function* (hostId: string) {
  const fs = yield* FileSystem.FileSystem;
  const server = yield* ServerConfig.ServerConfig;
  const environmentId = yield* fs
    .readFileString(server.environmentIdPath)
    .pipe(Effect.orElseSucceed(() => server.stateDir));
  const digest = yield* Digest.Digest;
  const owner = yield* digest
    .digest(
      Digest.sha256,
      new TextEncoder().encode(`${environmentId}\0${server.stateDir}\0${hostId}`),
    )
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return owner.slice(0, 24);
});

export const probe = Effect.fn("SshDeviceHost.probe")(function* (
  config: SshDeviceHostConfig,
  owner?: string,
  binding?: DeviceHost.DeviceSshBinding,
) {
  const result = yield* bootstrap(
    config,
    owner ?? (yield* ownerFor(config.id)),
    "probe",
    binding,
  ).pipe(Effect.catchTags({ DeviceHostError: (error) => explainWindowsHost(config, error) }));
  const value = yield* decodeProbe(result.stdout.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new DeviceHost.DeviceHostError({ hostId: config.id, step: "reading probe result", cause }),
    ),
  );
  return {
    id: config.id,
    label: config.label,
    kind: "ssh",
    tools: value.tools,
    hubInstalled:
      value.tools?.hub.installedVersions.includes(value.tools.hub.requiredVersion) ?? false,
    agentDeviceInstalled:
      value.tools?.agent.installedVersions.includes(value.tools.agent.requiredVersion) ?? false,
    platforms: value.platforms,
  } satisfies DeviceHostSummary;
});

export const make = Effect.fn("SshDeviceHost.make")(function* (
  config: SshDeviceHostConfig,
  onReady: (
    ready: DeviceHost.DeviceHostAgentReady,
  ) => Effect.Effect<void, DeviceHost.DeviceHostError> = () => Effect.void,
  onStatus: (
    status: "starting" | "ready" | "failed",
    detail?: string,
  ) => Effect.Effect<void> = () => Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const server = yield* ServerConfig.ServerConfig;
  const net = yield* NetService.NetService;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const digest = yield* Digest.Digest;
  const parentScope = yield* Scope.Scope;
  const ssh = yield* resolveSshCommand;
  const owner = yield* ownerFor(config.id);
  const provide = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | ChildProcessSpawner.ChildProcessSpawner
      | Digest.Digest
      | ServerConfig.ServerConfig
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, server),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(Digest.Digest, digest),
    );
  const lock = yield* Semaphore.make(1);
  let stopped = false;
  let activated = false;
  let wantsAgent = false;
  let ready:
    | (DeviceHost.DeviceHostReady & {
        agentDevice?: DeviceHost.DeviceHostAgentReady["agentDevice"];
      })
    | null = null;
  let connectionScope: Scope.Closeable | null = null;
  let bindingState:
    | {
        readonly binding: DeviceHost.DeviceSshBinding;
        readonly released: Deferred.Deferred<void>;
        closed: boolean;
      }
    | undefined;
  const bindingError = (cause?: unknown) =>
    new DeviceHost.DeviceHostError({
      hostId: config.id,
      step: "using private SSH binding",
      cause,
    });
  const withTransport = Effect.fn("SshDeviceHost.withTransport")(function* <A, E, R>(
    operation: (binding: DeviceHost.DeviceSshBinding | undefined) => Effect.Effect<A, E, R>,
    expected?: { readonly state: typeof bindingState },
  ): Effect.fn.Return<A, E | DeviceHost.DeviceHostError, R> {
    if (expected && expected.state !== bindingState) return yield* bindingError();
    const current = expected ? expected.state : bindingState;
    if (!current) return yield* operation(undefined);
    if (current.closed) return yield* bindingError();
    return yield* Effect.raceFirst(
      Effect.raceFirst(current.binding.revoked, Deferred.await(current.released)).pipe(
        Effect.andThen(Effect.fail(bindingError())),
      ),
      current.binding.check.pipe(
        Effect.mapError(bindingError),
        Effect.andThen(Effect.suspend(() => operation(current.binding))),
      ),
    );
  });
  let summary: DeviceHostSummary = {
    id: config.id,
    label: config.label,
    kind: "ssh",
    hubInstalled: false,
    agentDeviceInstalled: false,
    platforms: [],
  };

  const runOn =
    (expected: { readonly state: typeof bindingState }): DeviceHost.DeviceHostReady["run"] =>
    (command, args, options) =>
      withTransport(
        (binding) =>
          provide(
            runSshCommand(targetFor(config, binding), {
              preHostArgs: identityArgs(config, binding),
              // Match the hub cwd so relative executables and PATH entries resolve identically.
              remoteCommandArgs: commandArgs(
                `cd "$HOME/.t3/device/hosts/${owner}" && exec ${[command, ...args].map(quoteRemoteArg).join(" ")}`,
              ),
              keepErrorOutputTail: true,
              ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
              ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            }),
          ),
        expected,
      ).pipe(
        Effect.map((result) => ({ ...result, code: 0 })),
        Effect.catch((error) =>
          Effect.succeed({
            stdout: "stdout" in error ? (error.stdout ?? "") : "",
            stderr: error.message,
            code: "exitCode" in error ? (error.exitCode ?? 127) : 127,
          }),
        ),
      );

  const platformAvailability: DeviceHost.DeviceHost["Service"]["platformAvailability"] = (
    platform,
  ) =>
    withTransport((binding) => provide(probe(config, owner, binding))).pipe(
      Effect.map((value) => {
        summary = { ...summary, platforms: value.platforms };
        return value.platforms.find((p) => p.platform === platform)!;
      }),
      Effect.orElseSucceed(() => ({
        platform,
        available: false,
        reason: "Cannot reach device host. Test its SSH connection in Settings.",
      })),
    );

  const connectOnce = Effect.fn("SshDeviceHost.connectOnce")(function* (): Effect.fn.Return<
    DeviceHost.DeviceHostReady & { agentDevice?: DeviceHost.DeviceHostAgentReady["agentDevice"] },
    DeviceHost.DeviceHostError
  > {
    yield* withTransport(() => Effect.void);
    const binding = bindingState?.binding;
    const run = runOn({ state: bindingState });
    activated = true;
    const result = yield* withTransport((transport) =>
      provide(bootstrap(config, owner, wantsAgent ? "agent-start" : "start", transport)),
    );
    yield* onStatus("starting");
    const remote = yield* decodeStarted(result.stdout.trim()).pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId: config.id,
            step: "reading host endpoints",
            cause,
          }),
      ),
    );
    summary = {
      ...summary,
      platforms: remote.platforms,
      tools: remote.tools,
      hubInstalled: true,
      agentDeviceInstalled: wantsAgent || summary.agentDeviceInstalled,
    };
    const hubPort = yield* net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId: config.id,
            step: "reserving hub port",
            cause,
          }),
      ),
    );
    const daemonPort = yield* net.reserveLoopbackPort("127.0.0.1").pipe(
      Effect.mapError(
        (cause) =>
          new DeviceHost.DeviceHostError({
            hostId: config.id,
            step: "reserving daemon port",
            cause,
          }),
      ),
    );
    const scope = yield* Scope.make();
    connectionScope = scope;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          ssh,
          [
            ...baseSshArgs(targetFor(config, binding), { batchMode: "yes" }),
            ...identityArgs(config, binding),
            "-o",
            "ExitOnForwardFailure=yes",
            // Multiplexed clients exit after handing forwards to the master; own this connection.
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ControlPersist=no",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            "-T",
            "-L",
            `127.0.0.1:${hubPort}:127.0.0.1:${remote.hubPort}`,
            ...(remote.daemonPort === undefined
              ? []
              : ["-L", `127.0.0.1:${daemonPort}:127.0.0.1:${remote.daemonPort}`]),
            binding ? `${binding.username}@${binding.hostname}` : config.target,
            // The server holds the only write end of this stdin, so when it exits for any
            // reason the remote `cat` sees EOF and ssh exits once its forwarded connections
            // close, instead of being orphaned.
            "sh",
            "-c",
            quoteRemoteArg("exec cat >/dev/null"),
          ],
          { stdin: "pipe", stdout: "ignore", stderr: "pipe" },
        ),
      )
      .pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId: config.id, step: "forwarding ports", cause }),
        ),
      );
    let stderr = "";
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          stderr = (stderr + chunk).slice(-2000);
        }),
      ),
      Effect.forkIn(scope),
    );
    const hubOrigin = `http://127.0.0.1:${hubPort}`;
    const next = {
      nodePath: remote.nodePath,
      hub: { origin: hubOrigin },
      devices: makeDeviceHubOperations({
        hostId: config.id,
        origin: hubOrigin,
        http,
        run,
        // Keep probing negative reports so tooling installed after connecting is still found.
        platformAvailable: (platform) =>
          Effect.suspend(() =>
            summary.platforms.some((p) => p.platform === platform && p.available)
              ? Effect.succeed(true)
              : platformAvailability(platform).pipe(
                  Effect.map((availability) => availability.available),
                ),
          ),
      }),
      ...(remote.daemonPort !== undefined &&
      remote.token !== undefined &&
      remote.entryPath !== undefined
        ? {
            agentDevice: {
              baseUrl: `http://127.0.0.1:${daemonPort}`,
              token: remote.token,
              entryPath: remote.entryPath,
            },
          }
        : {}),
      helpers: remote.helpers,
      run,
    };
    for (const [baseUrl, route] of [
      [next.hub.origin, "/readyz"],
      ...(next.agentDevice ? [[next.agentDevice.baseUrl, "/health"]] : []),
    ]) {
      yield* waitForHttpReady({
        baseUrl: baseUrl!,
        path: route!,
        timeoutMs: 15000,
        makeError: () =>
          new DeviceHost.DeviceHostError({
            hostId: config.id,
            step: "waiting for SSH forward",
            cause: new Error(stderr || "Forwarded endpoint did not answer."),
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    }
    if (next.agentDevice) yield* onReady({ ...next, agentDevice: next.agentDevice });
    ready = next.agentDevice
      ? { ...next, releaseAgentSession: releaseAgentDeviceSession(http, next.agentDevice) }
      : next;
    yield* onStatus("ready");
    // Reconnect also repairs helpers that died while SSH itself stayed connected.
    // A loaded host can miss a probe or two while still working, and reconnecting
    // then drops the forward in use, so only consecutive misses count.
    const unhealthy = Effect.gen(function* () {
      let misses = 0;
      while (true) {
        yield* Effect.sleep("10 seconds");
        const alive = yield* http.get(`${next.hub.origin}/readyz`).pipe(
          Effect.timeout("5 seconds"),
          Effect.map((r) => r.status === 200),
          Effect.orElseSucceed(() => false),
        );
        const daemonAlive = next.agentDevice
          ? yield* http.get(`${next.agentDevice!.baseUrl}/health`).pipe(
              Effect.timeout("5 seconds"),
              Effect.map((r) => r.status === 200),
              Effect.orElseSucceed(() => false),
            )
          : true;
        misses = alive && daemonAlive ? 0 : misses + 1;
        if (misses >= UNHEALTHY_PROBE_LIMIT) return;
      }
    });
    yield* Effect.gen(function* () {
      yield* Effect.raceFirst(child.exitCode.pipe(Effect.ignore), unhealthy);
      if (stopped || connectionScope !== scope) return;
      ready = null;
      yield* onStatus("starting", "Reconnecting to device host…");
      yield* Scope.close(scope, Exit.void);
      let delay = 1000;
      while (true) {
        if (stopped || connectionScope !== scope) return;
        yield* Effect.sleep(delay);
        const result = yield* lock
          .withPermit(
            Effect.suspend(() => (stopped || ready ? Effect.void : connect().pipe(Effect.asVoid))),
          )
          .pipe(Effect.result);
        if (result._tag === "Success") return;
        yield* onStatus("failed", result.failure.message);
        if (connectionScope && connectionScope !== scope)
          yield* Scope.close(connectionScope, Exit.void);
        connectionScope = scope;
        delay = Math.min(delay * 2, 30000);
      }
    }).pipe(Effect.forkIn(parentScope));
    return next;
  });

  const connect = Effect.fn("SshDeviceHost.connect")(function* () {
    for (let attempt = 0; ; attempt++) {
      const result = yield* withTransport(() => connectOnce()).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      const failedScope = connectionScope;
      connectionScope = null;
      if (failedScope) yield* Scope.close(failedScope, Exit.void);
      // SSH binds after the reservation is released, so a competing bind needs fresh ports.
      if (
        attempt >= 2 ||
        !["forwarding ports", "waiting for SSH forward"].includes(result.failure.step)
      )
        return yield* result.failure;
    }
  });

  const ensureReady: DeviceHost.DeviceHost["Service"]["ensureReady"] = (onPhase) =>
    withTransport((binding) =>
      lock.withPermit(
        Effect.gen(function* () {
          stopped = false;
          if (ready) return ready;
          summary = yield* provide(probe(config, owner, binding));
          yield* onPhase(
            summary.hubInstalled ? "starting" : "installing",
            summary.hubInstalled
              ? undefined
              : deviceToolInstallMessage("device hub", summary.tools?.hub),
          );
          return yield* connect().pipe(
            Effect.tapError(() =>
              connectionScope ? Scope.close(connectionScope, Exit.void) : Effect.void,
            ),
          );
        }),
      ),
    );
  const stopUnlocked = Effect.gen(function* () {
    stopped = true;
    ready = null;
    if (connectionScope) yield* Scope.close(connectionScope, Exit.void);
    connectionScope = null;
    if (activated)
      yield* provide(bootstrap(config, owner, "stop", bindingState?.binding)).pipe(Effect.ignore);
    activated = false;
    wantsAgent = false;
  });
  const stop = lock.withPermit(stopUnlocked);
  const changeAgent = (enabled: boolean) =>
    withTransport(() =>
      lock.withPermit(
        Effect.gen(function* () {
          wantsAgent = enabled;
          if (enabled && ready?.agentDevice) return { ...ready, agentDevice: ready.agentDevice };
          if (!enabled && !ready?.agentDevice) return null;
          ready = null;
          const previousScope = connectionScope;
          connectionScope = null;
          if (previousScope) yield* Scope.close(previousScope, Exit.void);
          if (!enabled)
            yield* provide(bootstrap(config, owner, "stop-agent", bindingState?.binding));
          return yield* connect().pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                const failedScope = connectionScope;
                connectionScope = null;
                if (failedScope) yield* Scope.close(failedScope, Exit.void);
                if (enabled)
                  yield* provide(
                    bootstrap(config, owner, "stop-agent", bindingState?.binding),
                  ).pipe(Effect.ignore);
              }),
            ),
          );
        }),
      ),
    );
  const bindSsh = Effect.fn("SshDeviceHost.bindSsh")(function* (
    binding: DeviceHost.DeviceSshBinding,
  ) {
    const releaseState = (current: NonNullable<typeof bindingState>) =>
      lock.withPermit(
        Effect.gen(function* () {
          if (bindingState !== current) return;
          current.closed = true;
          yield* Deferred.succeed(current.released, undefined);
          yield* stopUnlocked;
          bindingState = undefined;
        }),
      );
    yield* Effect.gen(function* () {
      yield* binding.check.pipe(Effect.mapError(bindingError));
      const resolved = yield* provide(
        runSshCommand(targetFor(config), {
          preHostArgs: [...identityArgs(config), "-G"],
        }),
      ).pipe(Effect.mapError(bindingError));
      const fields = ["hostname", "user", "port"].map((name) =>
        resolved.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith(`${name} `))
          .map((line) => line.slice(name.length + 1).trim()),
      );
      if (
        fields.some((values) => values.length !== 1 || !values[0]) ||
        !/^[0-9]+$/.test(fields[2]![0]!)
      )
        return yield* bindingError();
      const port = Number(fields[2]![0]);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return yield* bindingError();
      const target = parseSshResolveOutput(config.target, resolved.stdout);
      if (
        target.hostname !== binding.hostname ||
        target.username !== binding.username ||
        port !== binding.port ||
        binding.hostKeyAlias !== "crew-boat"
      )
        return yield* bindingError();
    }).pipe(Effect.raceFirst(binding.revoked.pipe(Effect.andThen(Effect.fail(bindingError())))));
    const current = yield* Effect.acquireRelease(
      lock.withPermit(
        Effect.gen(function* () {
          if (bindingState) return yield* bindingError();
          yield* binding.check.pipe(Effect.mapError(bindingError));
          yield* stopUnlocked;
          const state = { binding, released: yield* Deferred.make<void>(), closed: false };
          bindingState = state;
          return state;
        }),
      ),
      releaseState,
    );
    return releaseState(current);
  });

  yield* Effect.addFinalizer(() => stop);
  return {
    id: config.id,
    label: config.label,
    bindSsh,
    summary: Effect.sync(() => summary),
    inspect: withTransport((binding) => provide(probe(config, owner, binding))).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          summary = value;
        }),
      ),
    ),
    current: withTransport(() => Effect.sync(() => ready)).pipe(Effect.orElseSucceed(() => null)),
    ensureReady,
    ensureAgentReady: (onPhase) =>
      ensureReady(onPhase).pipe(
        Effect.flatMap(() =>
          onPhase(
            summary.agentDeviceInstalled ? "starting" : "installing",
            summary.agentDeviceInstalled
              ? undefined
              : deviceToolInstallMessage("agent tools", summary.tools?.agent),
          ),
        ),
        Effect.flatMap(() => changeAgent(true)),
        Effect.flatMap((value) =>
          value?.agentDevice
            ? Effect.succeed({ ...value, agentDevice: value.agentDevice })
            : Effect.fail(
                new DeviceHost.DeviceHostError({
                  hostId: config.id,
                  step: "starting agent tools",
                  cause: new Error("Daemon endpoint missing"),
                }),
              ),
        ),
      ),
    stopAgent: changeAgent(false).pipe(Effect.asVoid, Effect.ignore),
    stop,
    platformAvailability,
  } satisfies DeviceHost.DeviceHost["Service"];
});

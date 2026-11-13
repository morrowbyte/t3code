import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import { SshCommandError, SshPasswordPromptError } from "./errors.ts";
import * as SshTunnel from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const makeRunningProcess = (onKill: () => void) => {
  let finish: ((exitCode: ChildProcessSpawner.ExitCode) => void) | null = null;
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: Effect.callback<ChildProcessSpawner.ExitCode>((resume) => {
      finish = (exitCode) => resume(Effect.succeed(exitCode));
      return Effect.sync(() => {
        finish = null;
      });
    }),
    isRunning: Effect.succeed(true),
    kill: () =>
      Effect.sync(() => {
        onKill();
        finish?.(ChildProcessSpawner.ExitCode(143));
      }),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

const testHttpClient = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 200 }))),
);

const hangingHttpClient = HttpClient.make(() => Effect.never);

const testNetService = NetService.NetService.of({
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(41_773),
  findAvailablePort: (preferred) => Effect.succeed(preferred),
});

function commandArgs(command: ChildProcess.Command): ReadonlyArray<string> {
  return command._tag === "StandardCommand" ? command.args : [];
}

const NODE_SCRIPT = { nodeScriptPath: "/workspace/apps/server/dist/bin.mjs" } as const;

const ARCHIVE = { archiveVersion: "1.2.3-preview.20260911.4" } as const;

describe("ssh tunnel scripts", () => {
  it("installs and runs the release archive without Node, npm, or npx", () => {
    const script = SshTunnel.buildRemoteT3RunnerScript(ARCHIVE);

    assert.include(script, "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'");
    assert.include(script, "T3_NODE_SCRIPT_PATH=''");
    assert.include(
      script,
      "T3_RELEASE_BASE_URL='https://github.com/morrowbyte/t3code/releases/download'",
    );
    assert.include(script, 'T3_RUNTIME_DIR="$HOME/.t3/runtime/versions/$T3_ARCHIVE_VERSION"');
    assert.include(script, 'T3_ARCHIVE="t3-$T3_ARCHIVE_VERSION-$T3_PLATFORM-$T3_ARCH.tar.gz"');
    assert.include(script, "SHA256SUMS");
    assert.include(script, 'exec "$T3_RUNTIME_DIR/t3" "$@"');
    assert.notInclude(script, "npx");
    assert.notInclude(script, "npm exec");
    assert.notInclude(script, "t3@latest");
    assert.notInclude(script, 'exec t3 "$@"');
    assert.include(
      script,
      'T3_LOCK="$HOME/.t3/runtime/versions/.$T3_ARCHIVE_VERSION.install.lock"',
    );
    assert.include(
      script,
      String.raw`while ! (set -C; printf '%s\n' "$$" > "$T3_LOCK") 2>/dev/null; do`,
    );
    assert.include(script, 'T3_LOCK_OWNER="$(cat "$T3_LOCK" 2>/dev/null || true)"');
    assert.include(script, 'if ! kill -0 "$T3_LOCK_OWNER" 2>/dev/null; then');
    assert.include(script, 'if [ "$T3_LOCK_UNOWNED" -ge 5 ]; then');
    assert.include(script, 'if [ "$T3_LOCK_WAITED" -ge 360 ]; then');
    assert.include(script, '"$T3_STAGING/SHA256SUMS" 30');
    assert.include(script, '"$T3_STAGING/$T3_ARCHIVE" 240');
    assert.notInclude(script, "T3_LOCK_CANDIDATE");
    assert.notInclude(script, "-mmin");
    assert.equal(script.split("if ! t3_runtime_ready; then").length - 1, 2);
    assert.isBelow(
      script.indexOf('"$T3_STAGING/t3" --version'),
      script.indexOf('> "$T3_STAGING/.install-complete"'),
    );
    assert.equal(script.split("ensure_remote_node_path || true").length - 1, 1);
    assert.isBelow(
      script.indexOf("ensure_remote_node_path || true"),
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
    );
    assert.isBelow(
      script.indexOf('exec node "$T3_NODE_SCRIPT_PATH" "$@"'),
      script.indexOf("T3_ARCHIVE_VERSION="),
    );

    const launch = SshTunnel.buildRemoteLaunchScript({
      ...ARCHIVE,
      releaseBaseUrl: "https://mirror.example/t3/",
    });
    assert.include(launch, "T3_ARCHIVE_MODE=1");
    assert.include(launch, "T3_RELEASE_BASE_URL='https://mirror.example/t3'");
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT"');
    assert.include(launch, '"$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"');
    assert.include(SshTunnel.buildRemoteLaunchScript(NODE_SCRIPT), "T3_ARCHIVE_MODE=0");
  });

  it("rejects archive versions that are not a single exact version segment", () => {
    for (const archiveVersion of [
      "../other",
      "1.2.3/evil",
      "1.2.3\\evil",
      "1.2.3-preview.1 x",
      "1.2.3-preview.1\nrm -rf /",
      "v1.2.3",
    ]) {
      assert.throws(
        () => SshTunnel.buildRemoteT3RunnerScript({ archiveVersion }),
        SshTunnel.SshInvalidArchiveVersionError,
        undefined,
        archiveVersion,
      );
    }
    assert.include(
      SshTunnel.buildRemoteT3RunnerScript(ARCHIVE),
      "T3_ARCHIVE_VERSION='1.2.3-preview.20260911.4'",
    );
  });

  it.effect("accepts launch JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawnedCommands: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        spawnedCommands.push(commandArgs(command));
        return makeSuccessfulProcess('loaded nvm default\n{"remotePort":3774}\n');
      }),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);

    return Effect.gen(function* () {
      const result = yield* SshTunnel.launchOrReuseRemoteServer(target, undefined, ARCHIVE);
      assert.equal(result.remotePort, 3774);
      assert.deepEqual(spawnedCommands[0]?.slice(-5, -1), ["sh", "-l", "-s", "--"]);
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("accepts pretty-printed pairing JSON after remote shell startup noise", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`loaded nvm default
{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "scopes": ["orchestration:read"],
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const layerSpawner = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const layerProcess = Layer.merge(NodeServices.layer, layerSpawner);
    return Effect.gen(function* () {
      const result = yield* SshTunnel.issueRemotePairingToken(target, undefined, ARCHIVE);
      assert.equal(result.credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(layerProcess));
  });

  it.effect("retains a bounded diagnostic tail when the tunnel exits before readiness", () =>
    Effect.gen(function* () {
      const diagnostic = "Connection refused: café";
      const output = new TextEncoder().encode(
        "old diagnostics\n" + "x".repeat(32_768) + "\n" + diagnostic,
      );
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                stderr: Stream.make(output.subarray(0, output.length - 1), output.subarray(-1)),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 1);
            assert.equal(result.failure.stderr.length, 16_384);
            assert.isTrue(result.failure.stderr.endsWith(diagnostic));
            assert.equal(result.failure.message, result.failure.stderr.trim());
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect("reports the real exit when reading tunnel diagnostics fails", () =>
    Effect.gen(function* () {
      const diagnostic = "Permission denied (publickey)";
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-N")
            ? {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(diagnostic)).pipe(
                  Stream.concat(
                    Stream.fail(
                      PlatformError.systemError({
                        _tag: "Unknown",
                        module: "Stream",
                        method: "read",
                        description: "stderr read failed",
                      }),
                    ),
                  ),
                ),
              }
            : makeSuccessfulProcess('{"remotePort":3773}\n'),
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, hangingHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        SshAuth.SshPasswordPrompt.disabledLayer,
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        if (Result.isFailure(result)) {
          assert.instanceOf(result.failure, SshCommandError);
          if (result.failure instanceof SshCommandError) {
            assert.equal(result.failure.exitCode, 255);
            assert.equal(result.failure.stderr, diagnostic);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each([
    {
      name: "does not ask for a password when the agent cannot sign an accepted key",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519 "/home/julius/.ssh/id_ed25519" from agent: communication with agent failed\r\n' +
        "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [],
    },
    {
      name: "asks for a password when signing failure has no agent provenance",
      stderr:
        'sign_and_send_pubkey: signing failed for ED25519-CERT "key-cert.pub": agent refused operation\n' +
        "julius@devbox: Permission denied (publickey,password).\n",
      expectedPromptAttempts: [1],
    },
    {
      name: "asks for a password when the server rejects every key",
      stderr: "julius@devbox: Permission denied (publickey,password).\r\n",
      expectedPromptAttempts: [1],
    },
  ])("$name", ({ stderr, expectedPromptAttempts }) =>
    Effect.gen(function* () {
      const promptAttempts: Array<number> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.succeed(
          commandArgs(command).includes("-G")
            ? makeSuccessfulProcess("")
            : {
                ...makeSuccessfulProcess(""),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(255)),
                stderr: Stream.make(new TextEncoder().encode(stderr)),
              },
        ),
      );
      const layer = Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.succeed(HttpClient.HttpClient, testHttpClient),
        Layer.succeed(NetService.NetService, testNetService),
        Layer.succeed(
          SshAuth.SshPasswordPrompt,
          SshAuth.SshPasswordPrompt.of({
            isAvailable: true,
            request: (request) =>
              Effect.sync(() => {
                promptAttempts.push(request.attempt);
                return null;
              }),
          }),
        ),
        SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
      );
      yield* Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const result = yield* Effect.result(
          manager.ensureEnvironment({
            alias: "devbox",
            hostname: "devbox",
            username: null,
            port: null,
          }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.deepEqual(promptAttempts, expectedPromptAttempts);
        if (Result.isFailure(result)) {
          if (expectedPromptAttempts.length === 0) {
            assert.instanceOf(result.failure, SshCommandError);
            if (result.failure instanceof SshCommandError) {
              assert.equal(result.failure.stderr, stderr);
            }
          } else {
            assert.instanceOf(result.failure, SshPasswordPromptError);
          }
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  it.effect.each(["absent", "exited", "unready"] as const)(
    "refuses a desktop browser helper for an %s tunnel without launching a server",
    (state) =>
      Effect.gen(function* () {
        let helperSpawns = 0;
        let launches = 0;
        let ready = true;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeSuccessfulProcess("");
            if (args.includes("-N")) {
              return {
                ...makeRunningProcess(() => undefined),
                isRunning: Effect.succeed(state !== "exited"),
              };
            }
            if (args.some((arg) => arg.includes("__ssh-helper desktop-browser"))) {
              helperSpawns += 1;
            }
            if (args.includes("-s")) launches += 1;
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("", { status: ready ? 200 : 503 }),
                ),
              ),
            ),
          ),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          if (state !== "absent") yield* manager.ensureEnvironment(target);
          ready = state !== "unready";
          const opening = yield* Effect.forkChild(
            Effect.result(manager.openDesktopBrowser(target, "target-environment", Stream.empty)),
          );
          yield* TestClock.adjust("2 seconds");
          const result = yield* Fiber.join(opening);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) assert.instanceOf(result.failure, SshCommandError);
          assert.equal(helperSpawns, 0);
          assert.equal(launches, state === "absent" ? 0 : 1);
        }).pipe(Effect.provide(layer), Effect.scoped);
      }),
  );

  it.effect.each(["caller", "caller EOF", "tunnel", "helper exit 0", "helper exit 1"] as const)(
    "closes the desktop browser helper and its proxy on %s closure",
    (owner) =>
      Effect.gen(function* () {
        const receivedReady = yield* Deferred.make<void>();
        const sentEvent = yield* Deferred.make<void>();
        const endEvents = yield* Deferred.make<void>();
        const helperExit = yield* Deferred.make<number>();
        const fenceStarted = yield* Deferred.make<void>();
        const finishFence = yield* Deferred.make<void>();
        const helperShutdownStarted = yield* Deferred.make<void>();
        const finishHelperShutdown = yield* Deferred.make<void>();
        let helperKills = 0;
        let tunnelKills = 0;
        let helperSpawns = 0;
        let helperArgs: ReadonlyArray<string> = [];
        let portReservations = 0;
        let reservedPort: number | undefined;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const otherTarget = { ...target, alias: "other", hostname: "other" };
        const autonomousExit = owner === "helper exit 0" || owner === "helper exit 1";
        const event = new TextEncoder().encode('{"type":"browser-event"}\n');
        const ready = new TextEncoder().encode(
          '{"type":"desktop-browser-ready","environmentId":"target-environment","processEpoch":"epoch"}\n',
        );
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.sync(() => {
            const args = commandArgs(command);
            if (args.includes("-G")) return makeSuccessfulProcess("");
            if (args.includes("-N")) return makeRunningProcess(() => tunnelKills++);
            if (args.some((arg) => arg.includes("__ssh-helper desktop-browser"))) {
              helperSpawns += 1;
              helperArgs = args;
              const helper = makeRunningProcess(() => helperKills++);
              const exitsAutonomously = autonomousExit && helperSpawns === 1;
              return {
                ...helper,
                exitCode: exitsAutonomously
                  ? Deferred.await(helperExit).pipe(Effect.map(ChildProcessSpawner.ExitCode))
                  : helper.exitCode,
                kill: (options?: ChildProcess.KillOptions) =>
                  Deferred.succeed(helperShutdownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishHelperShutdown)),
                    Effect.andThen(helper.kill(options)),
                  ),
                stdout: Stream.concat(
                  Stream.make(ready),
                  exitsAutonomously
                    ? Stream.fromEffectDrain(Deferred.await(helperExit))
                    : Stream.never,
                ),
                stdin: Sink.forEach((chunk: Uint8Array) => {
                  assert.deepEqual(chunk, event);
                  return Deferred.succeed(sentEvent, undefined);
                }),
              };
            }
            return makeSuccessfulProcess('{"remotePort":3773}\n');
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, {
            ...testNetService,
            reserveLoopbackPort: () =>
              Effect.sync(() => {
                const nextPort = 41_773 + portReservations++;
                return reservedPort ?? nextPort;
              }),
          }),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          const environment = yield* manager.ensureEnvironment(target);
          const callerScope = yield* Scope.make();
          const transport = yield* manager
            .openDesktopBrowser(
              target,
              "target-environment'$(false)",
              Stream.concat(Stream.make(event), Stream.fromEffectDrain(Deferred.await(endEvents))),
              Deferred.succeed(fenceStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishFence)),
              ),
            )
            .pipe(Effect.provideService(Scope.Scope, callerScope));
          const reading = yield* Effect.forkChild(
            Stream.runForEach(transport.commands, (chunk) => {
              assert.deepEqual(chunk, ready);
              return Deferred.succeed(receivedReady, undefined);
            }),
          );
          yield* Deferred.await(receivedReady);
          yield* Deferred.await(sentEvent);
          yield* manager.ensureEnvironment(otherTarget);
          const closed = yield* Effect.forkChild(transport.closed);
          const closing = yield* Effect.forkChild(
            owner === "caller"
              ? Scope.close(callerScope, Exit.void)
              : owner === "caller EOF"
                ? Deferred.succeed(endEvents, undefined).pipe(Effect.asVoid)
                : autonomousExit
                  ? Deferred.succeed(helperExit, owner === "helper exit 0" ? 0 : 1).pipe(
                      Effect.asVoid,
                    )
                  : manager.disconnectEnvironment(target),
          );
          yield* Effect.raceFirst(
            Deferred.await(fenceStarted),
            Effect.raceFirst(
              Deferred.await(helperShutdownStarted),
              transport.closed.pipe(Effect.ignore),
            ),
          );
          yield* TestClock.adjust(Duration.zero);
          assert.isTrue(yield* Deferred.isDone(fenceStarted));
          assert.equal(helperKills, 0);
          assert.isFalse(yield* Deferred.isDone(helperShutdownStarted));
          assert.isUndefined(closed.pollUnsafe());
          assert.isUndefined(reading.pollUnsafe());
          reservedPort = 41_774;
          const collision = yield* Effect.result(
            manager.openDesktopBrowser(otherTarget, "other-environment", Stream.never),
          );
          assert.isTrue(Result.isFailure(collision));
          if (Result.isFailure(collision)) assert.instanceOf(collision.failure, SshCommandError);
          const tunnelCollision = yield* Effect.result(
            manager.ensureEnvironment({ ...target, alias: "third", hostname: "third" }),
          );
          assert.isTrue(Result.isFailure(tunnelCollision));
          if (Result.isFailure(tunnelCollision))
            assert.instanceOf(tunnelCollision.failure, SshCommandError);
          assert.equal(helperSpawns, 1);
          assert.equal(portReservations, 5);
          yield* Deferred.succeed(finishFence, undefined);
          if (owner !== "helper exit 0") yield* Deferred.await(helperShutdownStarted);
          yield* TestClock.adjust(Duration.zero);
          const closedBeforeShutdown = closed.pollUnsafe();
          const commandsBeforeShutdown = reading.pollUnsafe();
          yield* Deferred.succeed(finishHelperShutdown, undefined);
          yield* Fiber.join(closing);
          if (owner !== "helper exit 0") {
            assert.isUndefined(closedBeforeShutdown);
            assert.isUndefined(commandsBeforeShutdown);
          }
          const closedResult = yield* Effect.result(Fiber.join(closed));
          const commandsResult = yield* Effect.result(Fiber.join(reading));
          if (owner === "helper exit 0") {
            assert.isTrue(Result.isSuccess(closedResult));
            assert.isTrue(Result.isSuccess(commandsResult));
          } else {
            assert.isTrue(Result.isFailure(closedResult));
            assert.isTrue(Result.isFailure(commandsResult));
          }
          assert.equal(helperKills, owner === "helper exit 0" ? 0 : 1);
          assert.equal(tunnelKills, owner === "tunnel" ? 1 : 0);
          assert.equal(helperSpawns, 1);
          assert.equal(portReservations, 5);
          assert.equal(transport.proxyUrl, "socks5://127.0.0.1:41774");
          assert.notEqual(transport.proxyUrl, environment.httpBaseUrl);
          assert.equal(helperArgs.filter((arg) => arg === "-D").length, 1);
          assert.equal(helperArgs[helperArgs.indexOf("-D") + 1], "127.0.0.1:41774");
          assert.include(helperArgs, "ExitOnForwardFailure=yes");
          assert.notInclude(helperArgs, "ExitOnForwardFailure=no");
          assert.include(helperArgs.at(-1) ?? "", "'target-environment'\\''$(false)'");
          assert.include(helperArgs, "ControlPath=none");
          assert.notInclude(helperArgs, "-N");
          assert.notInclude(helperArgs, "-n");
          const replacementScope = yield* Scope.make();
          const replacement = yield* manager
            .openDesktopBrowser(otherTarget, "other-environment", Stream.never)
            .pipe(Effect.provideService(Scope.Scope, replacementScope));
          assert.equal(replacement.proxyUrl, transport.proxyUrl);
          yield* Scope.close(callerScope, Exit.void);
          const lateCollision = yield* Effect.result(
            manager.openDesktopBrowser(otherTarget, "late-environment", Stream.never),
          );
          assert.isTrue(Result.isFailure(lateCollision));
          if (Result.isFailure(lateCollision))
            assert.instanceOf(lateCollision.failure, SshCommandError);
          assert.equal(helperSpawns, 2);
          yield* Scope.close(replacementScope, Exit.void);
          reservedPort = undefined;
          if (owner !== "tunnel") {
            assert.equal(
              (yield* manager.ensureEnvironment(target)).httpBaseUrl,
              environment.httpBaseUrl,
            );
          } else {
            yield* manager.ensureEnvironment(target);
          }
          yield* Scope.close(callerScope, Exit.void);
          assert.equal(tunnelKills, owner === "tunnel" ? 1 : 0);
          assert.equal(helperKills, owner === "helper exit 0" ? 1 : 2);
          const replay = yield* Effect.result(Stream.runCollect(transport.commands));
          assert.isTrue(Result.isFailure(replay));
          if (Result.isFailure(replay))
            assert.include(replay.failure.message, "cannot be replayed");
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishFence, undefined)),
          Effect.ensuring(Deferred.succeed(finishHelperShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );

  it.effect.each(["local tunnel", "remote server"] as const)(
    "waits for %s shutdown before reconnecting the same target",
    (stalledStep) =>
      Effect.gen(function* () {
        const shutdownStarted = yield* Deferred.make<void>();
        const finishShutdown = yield* Deferred.make<void>();
        const reconnectsStarted = yield* Deferred.make<void>();
        const pauseShutdown = Deferred.succeed(shutdownStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishShutdown)),
        );
        let resolutions = 0;
        let launches = 0;
        let tunnels = 0;
        let stops = 0;
        let remoteRunning = false;
        const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const args = commandArgs(command);
            const isTarget = args.includes(target.alias);
            if (args.includes("-G")) {
              if (isTarget && ++resolutions === 4) {
                yield* Deferred.succeed(reconnectsStarted, undefined);
              }
              return makeSuccessfulProcess("");
            }
            if (args.includes("-N")) {
              const tunnel = makeRunningProcess(() => undefined);
              if (isTarget && ++tunnels === 1 && stalledStep === "local tunnel") {
                return {
                  ...tunnel,
                  kill: (options?: ChildProcess.KillOptions) =>
                    pauseShutdown.pipe(Effect.andThen(tunnel.kill(options))),
                };
              }
              return tunnel;
            }
            if (args.some((arg, index) => arg === "-s" && args[index + 1] === "--")) {
              if (isTarget) {
                launches += 1;
                remoteRunning = true;
              }
              return makeSuccessfulProcess('{"remotePort":3773}\n');
            }
            const stop = makeSuccessfulProcess('{"stopped":true}\n');
            if (!isTarget) return stop;
            const pause = ++stops === 1 && stalledStep === "remote server";
            return {
              ...stop,
              exitCode: (pause ? pauseShutdown : Effect.void).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    remoteRunning = false;
                    return ChildProcessSpawner.ExitCode(0);
                  }),
                ),
              ),
            };
          }),
        );
        const layer = Layer.mergeAll(
          NodeServices.layer,
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Layer.succeed(HttpClient.HttpClient, testHttpClient),
          Layer.succeed(NetService.NetService, testNetService),
          SshAuth.SshPasswordPrompt.disabledLayer,
          SshTunnel.SshEnvironmentManager.layer({ resolveCliRunner: Effect.succeed(ARCHIVE) }),
        );
        yield* Effect.gen(function* () {
          const manager = yield* SshTunnel.SshEnvironmentManager;
          yield* manager.ensureEnvironment(target);
          const disconnect = yield* Effect.forkChild(manager.disconnectEnvironment(target));
          yield* Deferred.await(shutdownStarted);
          const firstReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          const secondReconnect = yield* Effect.forkChild(manager.ensureEnvironment(target));
          yield* Deferred.await(reconnectsStarted);

          yield* manager.ensureEnvironment({
            alias: "other",
            hostname: "other",
            username: null,
            port: null,
          });
          yield* TestClock.adjust(Duration.zero);
          const launchesBeforeShutdown = launches;
          yield* Deferred.succeed(finishShutdown, undefined);
          yield* Fiber.join(disconnect);
          const first = yield* Fiber.join(firstReconnect);
          const second = yield* Fiber.join(secondReconnect);

          assert.equal(launchesBeforeShutdown, 1);
          assert.equal(launches, 2);
          assert.equal(tunnels, 2);
          assert.isTrue(remoteRunning);
          assert.equal(first.httpBaseUrl, second.httpBaseUrl);
        }).pipe(
          Effect.ensuring(Deferred.succeed(finishShutdown, undefined)),
          Effect.provide(layer),
          Effect.scoped,
        );
      }),
  );
});

// On macOS, Node can bind 127.0.0.1:<port> while another process (such as the
// desktop app with network access on) listens on *:<port>. Linux refuses that
// bind unless both sockets set SO_REUSEPORT, so on Linux the preload adds it to
// the picker's probe and the holder sets it too.

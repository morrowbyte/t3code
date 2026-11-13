import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import {
  type DevShareError,
  DevServeFailedError,
  shareDevServer,
  unshareDevServer,
} from "./dev-share.ts";

const TAILNET_STATUS = JSON.stringify({ Self: { DNSName: "host.example.ts.net." } });
const NO_HANDLER_STDERR = "error: failed to remove web serve: handler does not exist";

interface CallResult {
  readonly exitCode: number;
  readonly stderr?: string;
}

const encode = (value: string) => Stream.make(new TextEncoder().encode(value));

const spawnerLayer = (input: {
  readonly off?: CallResult;
  readonly serve?: CallResult;
  readonly calls?: Array<ReadonlyArray<string>>;
  readonly cleanup?: CallResult;
}) => {
  let route: string | null = null;
  let removals = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = "args" in command ? (command.args as ReadonlyArray<string>) : [];
      input.calls?.push(args);
      const result: CallResult = args.includes("status")
        ? { exitCode: 0 }
        : args.includes("off")
          ? ++removals > 1
            ? (input.cleanup ?? input.off ?? { exitCode: 0 })
            : (input.off ?? { exitCode: 0 })
          : (input.serve ?? { exitCode: 0 });

      if (args.includes("off") && (result.exitCode === 0 || result.stderr === NO_HANDLER_STDERR))
        route = null;
      if (args.includes("--bg") && result.exitCode === 0) route = args.at(-1) ?? null;
      const serveStatus =
        route === null
          ? "null"
          : JSON.stringify({
              TCP: { "5788": { HTTPS: true } },
              Web: { "host.example.ts.net:5788": { Handlers: { "/": { Proxy: route } } } },
            });
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: args.includes("status")
            ? encode(args[0] === "serve" ? serveStatus : TAILNET_STATUS)
            : Stream.empty,
          stderr: result.stderr ? encode(result.stderr) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );
};

const withPrivateHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      return yield* effect.pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("unshareDevServer", () => {
  // `tailscale serve … off` exits 1 when the port had no mapping, which is the
  // normal first-share case — the port is clear, so this must not be an error.
  it.effect("treats a missing handler as cleared", () =>
    Effect.gen(function* () {
      const result = yield* withPrivateHome(
        Effect.gen(function* () {
          const shared = yield* shareDevServer({ webPort: 5788 });
          return yield* unshareDevServer(5788, shared.ownership.generation);
        }).pipe(
          Effect.provide(spawnerLayer({ cleanup: { exitCode: 1, stderr: NO_HANDLER_STDERR } })),
        ),
      );
      assert.isTrue(result.cleared);
    }),
  );

  it.effect("reports a genuine removal failure as not cleared", () =>
    Effect.gen(function* () {
      const result = yield* withPrivateHome(
        Effect.gen(function* () {
          const shared = yield* shareDevServer({ webPort: 5788 });
          return yield* unshareDevServer(5788, shared.ownership.generation);
        }).pipe(
          Effect.provide(spawnerLayer({ cleanup: { exitCode: 1, stderr: "permission denied" } })),
        ),
      );
      assert.isFalse(result.cleared);
    }),
  );
});

describe("shareDevServer", () => {
  // Vite binds `localhost`, which modern Node resolves to `::1` first, so a
  // 127.0.0.1 target would proxy to a loopback nothing listens on.
  it.effect("proxies to the localhost name Vite binds, not 127.0.0.1", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string>> = [];
      yield* withPrivateHome(
        shareDevServer({ webPort: 5788 }).pipe(
          Effect.provide(spawnerLayer({ off: { exitCode: 0 }, calls })),
        ),
      );

      const serveCall = calls.find((args) => args.includes("--bg"));
      assert.deepEqual(serveCall, ["serve", "--bg", "--https=5788", "http://localhost:5788"]);
    }),
  );

  it.effect("explains a recognized serve failure without quoting stderr", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* withPrivateHome(
        shareDevServer({ webPort: 5788 }).pipe(
          Effect.provide(
            spawnerLayer({
              off: { exitCode: 0 },
              serve: {
                exitCode: 1,
                stderr: "permission denied for tskey-auth-secret-token-value",
              },
            }),
          ),
          Effect.flip,
        ),
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "serve");
      assert.include(error.message, "permission denied");
      assert.include(error.message, "elevated privileges");
      assert.notInclude(error.message, "tskey-auth-secret-token-value");
    }),
  );

  it.effect("refuses to serve when the existing mapping could not be cleared", () =>
    Effect.gen(function* () {
      const error: DevShareError = yield* withPrivateHome(
        shareDevServer({ webPort: 5788 }).pipe(
          Effect.provide(spawnerLayer({ off: { exitCode: 1, stderr: "permission denied" } })),
          Effect.flip,
        ),
      );

      assert.instanceOf(error, DevServeFailedError);
      assert.equal(error.stage, "clear-existing");
      assert.include(error.message, "could not clear the existing mapping");
      assert.include(error.message, "permission denied");
    }),
  );
});

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Queue from "effect/Queue";
import { DesktopTelemetryControlMessage, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
// @effect-diagnostics nodeBuiltinImport:off

import { it } from "@effect/vitest";
import * as NodeTls from "node:tls";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import {
  make,
  makeApplyDesktopShellEnvironmentSnapshot,
  requireDesktopTelemetryWriteProgress,
} from "./DesktopTelemetryReceiver.ts";
import * as DateTime from "effect/DateTime";
import { assert } from "vite-plus/test";

describe("DesktopTelemetryReceiver", () => {
  it.live(
    "preserves system and bundled roots when the first snapshot withdraws overlapping extras",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped();
        const certificatePath = path.join(directory, "startup-extra-ca.pem");
        yield* fs.writeFileString(
          certificatePath,
          [...NodeTls.getCACertificates("system"), ...NodeTls.rootCertificates].join("\n"),
        );
        const child = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [
              "--use-bundled-ca",
              "--use-system-ca",
              "--input-type=module",
              "--eval",
              `
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTls from "node:tls";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeApplyDesktopShellEnvironmentSnapshot } from ${JSON.stringify(new URL("./DesktopTelemetryReceiver.ts", import.meta.url).href)};
const fingerprints = (certificates) => [...new Set(certificates.map((pem) => new NodeCrypto.X509Certificate(pem).fingerprint256))].sort();
const expected = fingerprints([...NodeTls.getCACertificates("bundled"), ...NodeTls.getCACertificates("system")]);
const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(process.env, process.platform);
await Effect.runPromise(applySnapshot({
  version: 1,
  type: "shellEnvironment",
  platform: process.platform,
  discovered: true,
  environment: { NODE_EXTRA_CA_CERTS: null },
}).pipe(Effect.provide(NodeServices.layer)));
NodeAssert.equal(process.env.NODE_EXTRA_CA_CERTS, undefined);
NodeAssert.deepEqual(fingerprints(NodeTls.getCACertificates("default")), expected);
`,
            ],
            {
              cwd: path.resolve(import.meta.dirname, "../.."),
              env: { NODE_OPTIONS: "", NODE_EXTRA_CA_CERTS: certificatePath },
            },
          ),
        );
        const result = yield* Effect.all(
          {
            stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
            exitCode: child.exitCode.pipe(Effect.map(Number)),
          },
          { concurrency: "unbounded" },
        );
        expect(result.exitCode, result.stderr).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("updates live TLS trust when shell certificates arrive after startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const certificatePath = path.join(directory, "extra-ca.pem");
      const original = NodeTls.getCACertificates("default");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeTls.setDefaultCACertificates(original)),
      );
      const baseline = NodeTls.rootCertificates[0]!;
      const extra = NodeTls.rootCertificates[1]!;
      const replacement = NodeTls.rootCertificates[2]!;
      NodeTls.setDefaultCACertificates([baseline]);
      yield* fs.writeFileString(certificatePath, `${extra}\n${replacement}`);
      const environment: NodeJS.ProcessEnv = { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" };
      const applySnapshot = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      const message = {
        version: 1,
        type: "shellEnvironment",
        platform: "darwin",
        discovered: true,
        environment: { NODE_EXTRA_CA_CERTS: certificatePath },
      } as const;
      const fingerprints = (certificates: ReadonlyArray<string>) =>
        certificates.map((pem) => new NodeCrypto.X509Certificate(pem).fingerprint256).sort();
      yield* applySnapshot({ ...message, platform: "win32" });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING).toBe("1");
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, extra, replacement]),
      );
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
      expect(environment.T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING).toBeUndefined();

      yield* fs.writeFileString(certificatePath, replacement);
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* fs.writeFileString(
        certificatePath,
        "-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----",
      );
      yield* applySnapshot(message);
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );
      yield* fs.remove(certificatePath);
      const warnings: Array<Logger.Options<unknown>> = [];
      yield* applySnapshot(message).pipe(
        Effect.provide(
          Logger.layer([Logger.make((entry) => warnings.push(entry))], {
            mergeWithExisting: false,
          }),
        ),
      );
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.message).toEqual(["Failed to update desktop shell TLS certificates."]);
      expect(Cause.squash(warnings[0]!.cause)).toMatchObject({ _tag: "PlatformError" });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(
        fingerprints([baseline, replacement]),
      );

      yield* applySnapshot({ ...message, environment: { NODE_EXTRA_CA_CERTS: null } });
      expect(fingerprints(NodeTls.getCACertificates("default"))).toEqual(fingerprints([baseline]));
      expect(environment.NODE_EXTRA_CA_CERTS).toBeUndefined();

      NodeTls.setDefaultCACertificates([]);
      yield* fs.writeFileString(certificatePath, extra);
      const applyOpaqueTrust = makeApplyDesktopShellEnvironmentSnapshot(environment, "darwin");
      yield* applyOpaqueTrust(message);
      expect(NodeTls.getCACertificates("default")).toEqual([]);
      expect(environment.NODE_EXTRA_CA_CERTS).toBe(certificatePath);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each([
    { platform: "darwin", discovered: true, applied: true, pending: false },
    { platform: "win32", discovered: true, applied: false, pending: true },
    { platform: "darwin", discovered: false, applied: true, pending: true },
  ])(
    "applies platform=$platform discovered=$discovered with pending=$pending",
    ({ platform, discovered, applied, pending }) =>
      Effect.gen(function* () {
        const environment: NodeJS.ProcessEnv = {
          PATH: "/old/bin",
          JAVA_HOME: "/old/java",
          UNRELATED: "keep",
          T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1",
        };
        yield* makeApplyDesktopShellEnvironmentSnapshot(
          environment,
          "darwin",
        )({
          version: 1,
          type: "shellEnvironment",
          platform,
          discovered,
          environment: { PATH: "/fresh/bin", JAVA_HOME: null },
        });
        expect(environment).toEqual({
          PATH: applied ? "/fresh/bin" : "/old/bin",
          ...(applied ? {} : { JAVA_HOME: "/old/java" }),
          UNRELATED: "keep",
          ...(pending ? { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" } : {}),
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});

it.effect.each(["none", "top", "nested"] as const)(
  "requires paired support and strict %s reply fields on the actual NDJSON receiver",
  (extra) =>
    Effect.gen(function* () {
      const inputQueue = yield* Queue.unbounded<string, Cause.Done>();
      const inputStream = yield* NodeStream.toReadable(Stream.fromQueue(inputQueue));
      const requestSeen =
        yield* Deferred.make<
          Extract<DesktopTelemetryControlMessage, { type: "mainRendererDiagnosticsRequest" }>
        >();
      const commands: DesktopTelemetryControlMessage[] = [];
      const config = yield* ServerConfig.ServerConfig;
      const decodeControl = Schema.decodeUnknownEffect(
        Schema.fromJsonString(DesktopTelemetryControlMessage),
      );
      const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
      const receiver = yield* make({
        readable: inputStream,
        write: (_fd, bytes) =>
          Effect.gen(function* () {
            const message = yield* decodeControl(new TextDecoder().decode(bytes)).pipe(
              Effect.orDie,
            );
            commands.push(message);
            if (message.type === "mainRendererDiagnosticsRequest")
              yield* Deferred.succeed(requestSeen, message);
          }),
      }).pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          desktopTelemetryFd: 7,
          desktopTelemetryControlFd: 8,
        }),
      );
      const request = {
        requestId: "read",
        requestNonce: "nonce",
        optIn: true as const,
        expiresAtMs: DateTime.toEpochMillis(yield* DateTime.now) + 5_000,
        target: {
          environmentId: "24efa85c-862c-4de4-9b5e-aaaa041e28a4" as const,
          threadId: "7cd05d6b-5e09-4691-a664-0b56c6283f12" as const,
          providerInstanceId: "codex",
        },
      };
      assert.deepEqual(
        yield* receiver.readMainRendererDiagnostics!(request, request.target.environmentId),
        { status: "unavailable", reason: "unsupported" },
      );
      assert.equal(
        commands.some((m) => m.type === "mainRendererDiagnosticsPeer"),
        false,
      );
      yield* Queue.offer(
        inputQueue,
        (yield* encode({
          version: 1,
          type: "desktopTelemetryHello",
          electronPid: 1,
          legacyExtra: "preserved compatibility",
          mainRendererDiagnostics: { revision: 1, desktopNonce: "desktop" },
        })) + "\n",
      );
      // This actual decoded hello updates health; subscribe-before-write provides the milestone.
      const read = yield* Effect.gen(function* () {
        const health = yield* receiver.subscribeHealth;
        if (health.latest.status !== "healthy")
          yield* health.changes.pipe(
            Stream.filter((v) => v.status === "healthy"),
            Stream.runHead,
          );
        return yield* receiver.readMainRendererDiagnostics!(request, request.target.environmentId);
      }).pipe(Effect.forkScoped);
      const sent = yield* Deferred.await(requestSeen);
      const reply = {
        version: 1,
        type: "mainRendererDiagnosticsReply",
        desktopNonce: "desktop",
        serverNonce: sent.serverNonce,
        requestId: request.requestId,
        requestNonce: request.requestNonce,
        result: { status: "unavailable", reason: "off" },
      } as const;
      yield* Queue.offer(
        inputQueue,
        (yield* encode({
          ...reply,
          requestNonce: "wrong",
          result: { status: "unavailable", reason: "invalid-response" },
        })) + "\n",
      );
      const rawReply =
        extra === "top"
          ? { ...reply, rawSettings: "refused" }
          : extra === "nested"
            ? { ...reply, result: { ...reply.result, rawSettings: "refused" } }
            : reply;
      yield* Queue.offer(inputQueue, (yield* encode(rawReply)) + "\n");
      assert.deepEqual(yield* Fiber.join(read), {
        status: "unavailable",
        reason: extra === "none" ? "off" : "source-closed",
      });
      if (extra !== "none") {
        assert.equal((yield* receiver.subscribeHealth).latest.status, "degraded");
      }
      assert.equal(commands.filter((m) => m.type === "mainRendererDiagnosticsPeer").length, 1);
      assert.equal(commands.filter((m) => m.type === "mainRendererDiagnosticsRequest").length, 1);
      yield* Queue.end(inputQueue);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerConfig.layerTest("/fixture", { prefix: "main-renderer-receiver" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        ),
      ),
    ),
);

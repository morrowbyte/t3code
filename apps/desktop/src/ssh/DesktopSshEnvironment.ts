import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { DESKTOP_BROWSER_REGISTRATION_MAX_BYTES, DesktopBrowserReady } from "@t3tools/contracts";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { resolveSshTarget, targetConnectionKey } from "@t3tools/ssh/command";
import { discoverSshHosts } from "@t3tools/ssh/config";
import {
  SshCommandError,
  SshHostDiscoveryError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "@t3tools/ssh/errors";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import type * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

export type DesktopSshEnvironmentRuntimeServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService;

export type DesktopSshEnvironmentOperationError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

export type DesktopSshEnvironmentDiscoverError = SshHostDiscoveryError;

export class DesktopSshEnvironment extends Context.Service<
  DesktopSshEnvironment,
  {
    readonly discoverHosts: (input?: {
      readonly homeDir?: string;
    }) => Effect.Effect<readonly DesktopDiscoveredSshHost[], DesktopSshEnvironmentDiscoverError>;
    readonly resolveHost: (
      alias: string,
    ) => Effect.Effect<DesktopSshEnvironmentTarget, SshCommandError | SshInvalidTargetError>;
    readonly ensureEnvironment: (
      target: DesktopSshEnvironmentTarget,
      options?: { readonly issuePairingToken?: boolean },
    ) => Effect.Effect<DesktopSshEnvironmentBootstrap, DesktopSshEnvironmentOperationError>;
    readonly disconnectEnvironment: (
      target: DesktopSshEnvironmentTarget,
    ) => Effect.Effect<void, DesktopSshEnvironmentOperationError>;
  }
>()("@t3tools/desktop/ssh/DesktopSshEnvironment") {}

export interface DesktopSshEnvironmentLayerOptions {
  readonly resolveCliRunner?: Effect.Effect<SshTunnel.RemoteT3RunnerOptions>;
}

function discoverDesktopSshHostsEffect(input?: { readonly homeDir?: string }) {
  return discoverSshHosts(input ?? {});
}

export function isDesktopSshPasswordPromptCancellation(
  error: unknown,
): error is SshPasswordPromptError {
  return (
    error instanceof SshPasswordPromptError &&
    DesktopSshPasswordPrompts.isDesktopSshPasswordPromptCancellation(error.cause)
  );
}

function unexpectedPasswordPromptError(error: never): never {
  throw new Error(`Unhandled desktop SSH password prompt error: ${String(error)}`);
}

function toSshPasswordPromptError(
  cause: DesktopSshPasswordPrompts.DesktopSshPasswordPromptRequestError,
): SshPasswordPromptError {
  let message: string;
  switch (cause._tag) {
    case "DesktopSshPromptRequestIdGenerationError":
      message = "Secure randomness is unavailable.";
      break;
    case "DesktopSshPromptWindowUnavailableError":
    case "DesktopSshPromptPresentationError":
      message = "Crew window is not available for SSH authentication.";
      break;
    case "DesktopSshPromptTimedOutError":
      message = `SSH authentication timed out for ${cause.destination}.`;
      break;
    case "DesktopSshPromptCancelledError":
      message = `SSH authentication cancelled for ${cause.destination}.`;
      break;
    case "DesktopSshPromptWindowClosedError":
      message = "SSH authentication was cancelled because the app window closed.";
      break;
    case "DesktopSshPromptServiceStoppedError":
      message = "SSH password prompt service stopped.";
      break;
    default:
      return unexpectedPasswordPromptError(cause);
  }
  return new SshPasswordPromptError({ message, cause });
}

const makePasswordPrompt = (
  prompts: DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
): SshAuth.SshPasswordPrompt["Service"] => ({
  isAvailable: true,
  request: (request: SshAuth.SshPasswordRequest) =>
    prompts.request(request).pipe(Effect.mapError(toSshPasswordPromptError)),
});

/** @public */
export const make = Effect.gen(function* () {
  const manager = yield* SshTunnel.SshEnvironmentManager;
  const browserHost = yield* DesktopBrowserHost.DesktopBrowserHost;
  const serviceScope = yield* Scope.Scope;
  const browserLock = yield* Semaphore.make(1);
  const browserConnections = new Map<
    string,
    {
      readonly environmentId: string;
      readonly scope: Scope.Closeable;
      readonly stopped: Deferred.Deferred<void>;
    }
  >();
  const prompts = yield* DesktopSshPasswordPrompts.DesktopSshPasswordPrompts;
  const runtimeContext = yield* Effect.context<DesktopSshEnvironmentRuntimeServices>();
  const passwordPrompt = SshAuth.SshPasswordPrompt.of(makePasswordPrompt(prompts));

  const decodeBrowserReady = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopBrowserReady));
  const ensureBrowserConnection = Effect.fn("desktop.ssh.ensureBrowserConnection")(
    (bootstrap: DesktopSshEnvironmentBootstrap) =>
      browserLock.withPermits(1)(
        Effect.gen(function* () {
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: bootstrap.httpBaseUrl,
          });
          const key = targetConnectionKey(bootstrap.target);
          const previous = browserConnections.get(key);
          if (
            previous?.environmentId === descriptor.environmentId &&
            !(yield* Deferred.isDone(previous.stopped))
          )
            return;
          if (previous) yield* Scope.close(previous.scope, Exit.void);
          const scope = yield* Scope.fork(serviceScope, "sequential");
          const ready = yield* Deferred.make<void, Error>();
          const stopped = yield* Deferred.make<void>();
          const binding = { environmentId: descriptor.environmentId, scope, stopped };
          let connection: ReturnType<typeof browserHost.createConnection> | undefined;
          const outgoing = yield* Queue.bounded<Uint8Array>(32);
          const events = Stream.fromQueue(outgoing);
          const start = Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                if (browserConnections.get(key) === binding) browserConnections.delete(key);
              }).pipe(
                Effect.andThen(Effect.suspend(() => connection?.closed ?? Effect.void)),
                Effect.andThen(
                  Deferred.fail(ready, new Error("The browser target connection closed.")),
                ),
                Effect.andThen(Deferred.succeed(stopped, undefined)),
              ),
            );
            const transport = yield* manager.openDesktopBrowser(
              bootstrap.target,
              descriptor.environmentId,
              events,
            );
            const activeConnection = browserHost.createConnection(
              descriptor.environmentId,
              transport.proxyUrl,
            );
            connection = activeConnection;
            yield* Effect.addFinalizer(() => activeConnection.closed);
            let registered = false;
            yield* transport.commands.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => {
                if (registered) return activeConnection.handleCommandLine(line);
                if (
                  new TextEncoder().encode(line).byteLength > DESKTOP_BROWSER_REGISTRATION_MAX_BYTES
                )
                  return Effect.fail(
                    new SshCommandError({
                      command: ["desktop-browser"],
                      exitCode: null,
                      stderr: "",
                      message: "The browser registration header exceeded its bound.",
                    }),
                  );
                return decodeBrowserReady(line).pipe(
                  Effect.flatMap((receipt) =>
                    Effect.gen(function* () {
                      if (receipt.environmentId !== descriptor.environmentId)
                        return yield* new SshCommandError({
                            command: ["desktop-browser"],
                            exitCode: null,
                            stderr: "",
                            message: "The browser target environment changed.",
                          });
                      // Subscribe before consuming commands coalesced with Ready in the same chunk.
                      yield* activeConnection.events.pipe(
                        Stream.runForEach((event) => Queue.offer(outgoing, event)),
                        Effect.onExit(() => Deferred.succeed(stopped, undefined)),
                        Effect.forkIn(scope, { startImmediately: true }),
                      );
                      registered = true;
                      yield* Deferred.succeed(ready, undefined);
                    }),
                  ),
                );
              }),
              Effect.onExit(() => Deferred.succeed(stopped, undefined)),
              Effect.catchCause(() => Effect.logWarning("desktop SSH browser stream stopped")),
              Effect.forkScoped,
            );
            yield* transport.closed.pipe(
              Effect.catchCause(() => Deferred.succeed(stopped, undefined)),
              Effect.forkScoped,
            );
          }).pipe(Scope.provide(scope));
          browserConnections.set(key, binding);
          yield* Effect.gen(function* () {
            yield* start;
            // The closer lives outside the scope whose reader it interrupts.
            yield* Deferred.await(stopped).pipe(
              Effect.andThen(Scope.close(scope, Exit.void)),
              Effect.forkIn(serviceScope),
            );
            yield* Deferred.await(ready);
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(scope, Exit.void) : Effect.void,
            ),
          );
        }),
      ),
  );

  return DesktopSshEnvironment.of({
    discoverHosts: Effect.fn("desktop.ssh.discoverHosts")(function* (input) {
      return yield* discoverDesktopSshHostsEffect(input);
    }, Effect.provide(runtimeContext)),
    resolveHost: Effect.fn("desktop.ssh.resolveHost")(function* (alias) {
      return yield* resolveSshTarget(alias.trim());
    }, Effect.provide(runtimeContext)),
    ensureEnvironment: Effect.fn("desktop.ssh.ensureEnvironment")(
      function* (target, ensureOptions) {
        const bootstrap = yield* manager.ensureEnvironment(target, ensureOptions);
        yield* ensureBrowserConnection(bootstrap).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : Effect.logWarning("desktop SSH browser host is unavailable"),
          ),
        );
        return bootstrap;
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
    disconnectEnvironment: Effect.fn("desktop.ssh.disconnectEnvironment")(
      function* (target) {
        const resolved = yield* resolveSshTarget(target.alias || target.hostname);
        const key = targetConnectionKey({
          ...resolved,
          ...(target.username === null ? {} : { username: target.username }),
          ...(target.port === null ? {} : { port: target.port }),
        });
        yield* browserLock.withPermits(1)(
          Effect.suspend(() => {
            const binding = browserConnections.get(key);
            return binding ? Scope.close(binding.scope, Exit.void) : Effect.void;
          }),
        );
        return yield* manager.disconnectEnvironment(target);
      },
      Effect.provideService(SshAuth.SshPasswordPrompt, passwordPrompt),
      Effect.provide(runtimeContext),
    ),
  });
});

export const layer = (options: DesktopSshEnvironmentLayerOptions = {}) =>
  Layer.effect(DesktopSshEnvironment, make).pipe(
    Layer.provide(
      SshTunnel.SshEnvironmentManager.layer(
        options.resolveCliRunner === undefined
          ? {}
          : { resolveCliRunner: options.resolveCliRunner },
      ),
    ),
  );

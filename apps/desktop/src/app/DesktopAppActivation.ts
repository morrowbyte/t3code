// @effect-diagnostics nodeBuiltinImport:off -- The activation adapter resolves its per-user OS temporary directory.
import * as NodeOS from "node:os";

import { NativeAuthorError } from "@t3tools/contracts";
import type {
  MainRendererDiagnosticsReadInput,
  DesktopAppActivationResponse,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type * as Electron from "electron";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as MainRendererDiagnostics from "../ipc/methods/mainRendererDiagnostics.ts";
import { startDesktopAppControlServer } from "./DesktopAppControlServer.ts";
import * as DesktopNativeAuthor from "./DesktopNativeAuthor.ts";
import { DesktopAppActivationBroker } from "./DesktopAppActivationBroker.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const REQUEST_TIMEOUT_MS = 15_000;

export class DesktopAppActivationStartError extends Schema.TaggedError<DesktopAppActivationStartError>()(
  "DesktopAppActivationStartError",
  {
    address: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not start the desktop app control socket at ${this.address}.`;
  }
}

export class DesktopAppActivation extends Context.Service<
  DesktopAppActivation,
  {
    readonly start: Effect.Effect<void, DesktopAppActivationStartError, Scope.Scope>;
    readonly setRendererReady: (ready: boolean) => Effect.Effect<void>;
    readonly complete: (response: DesktopAppActivationResponse) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopAppActivation") {}

const { logWarning } = makeComponentLogger("desktop-app-activation");

/** @public */
export const make = Effect.gen(function* () {
  const desktopEnvironment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const resultPresentation = {
    reuseMainWindow:
      desktopEnvironment.isDevelopment &&
      !desktopEnvironment.isPackaged &&
      process.env.T3CODE_SINGLE_ORIGIN_DEV === "1",
  };
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const path = yield* Path.Path;
  const userId = yield* HostProcess.UserId;
  const diagnostics = yield* Effect.serviceOption(MainRendererDiagnostics.MainRendererDiagnostics);
  const nativeAuthor = yield* Effect.serviceOption(DesktopNativeAuthor.DesktopNativeAuthor);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const address = resolveDesktopAppControlAddress({
    stateDir: path.resolve(desktopEnvironment.stateDir),
    platform: desktopEnvironment.platform,
    tempDir: NodeOS.tmpdir(),
    userId,
    joinPath: path.join,
  });
  let registeredWebContents: Electron.WebContents | null = null;
  let detachRendererListeners: (() => void) | null = null;

  const broker = new DesktopAppActivationBroker({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    activate: () => {
      void runPromise(
        desktopWindow.activate.pipe(
          Effect.catchCause((cause) => logWarning("failed to focus the desktop window", { cause })),
        ),
      );
    },
  });

  const clearRegisteredRenderer = () => {
    detachRendererListeners?.();
    detachRendererListeners = null;
    registeredWebContents = null;
    broker.clearRenderer();
  };

  return DesktopAppActivation.of({
    start: Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          startDesktopAppControlServer({
            ...address,
            userId,
            ...(desktopEnvironment.platform === "linux" &&
            Option.isSome(desktopEnvironment.profileId) &&
            desktopEnvironment.isPackaged &&
            Option.isSome(diagnostics)
              ? {
                  diagnostics: {
                    mainPid: process.pid,
                    stateDir: path.resolve(desktopEnvironment.stateDir),
                    appVersion: desktopEnvironment.appVersion,
                    read: (
                      source: string,
                      alive: () => boolean,
                      request: MainRendererDiagnosticsReadInput,
                    ) => runPromise(diagnostics.value.read(source, alive, request)),
                    cancel: (source: string) => {
                      void runPromise(diagnostics.value.cancelSource(source));
                    },
                  },
                }
              : {}),
            nativeAuthor: (request, alive) =>
              runPromise(
                Effect.gen(function* () {
                  if (Option.isNone(nativeAuthor) || !alive()) {
                    return yield* new NativeAuthorError({ code: "backend-unavailable" });
                  }
                  const state = yield* nativeAuthor.value.execute(request);
                  if (request.operation !== "open-results") {
                    return {
                      version: 1 as const,
                      requestId: request.requestId,
                      ok: true as const,
                      state,
                    };
                  }
                  if (!alive())
                    return yield* new NativeAuthorError({ code: "result-window-unavailable" });
                  const window = yield* desktopWindow
                    .openThreadWindow(
                      {
                        environmentId: state.locator.environmentId,
                        threadId: state.locator.threadId,
                        origin: state.locator,
                      },
                      alive,
                      resultPresentation,
                    )
                    .pipe(
                      Effect.mapError(
                        () => new NativeAuthorError({ code: "result-window-unavailable" }),
                      ),
                    );
                  return {
                    version: 1 as const,
                    requestId: request.requestId,
                    ok: true as const,
                    state,
                    windowId: window.id,
                  };
                }).pipe(
                  Effect.catchTags({
                    NativeAuthorError: (error) =>
                      Effect.succeed({
                        version: 1 as const,
                        requestId: request.requestId,
                        ok: false as const,
                        code: error.code,
                      }),
                  }),
                ),
              ),
            handle: (request) => broker.request(request),
            openResultConversation: (request, alive) =>
              runPromise(
                Effect.gen(function* () {
                  if (!alive()) {
                    return {
                      version: 1 as const,
                      requestId: request.requestId,
                      ok: false as const,
                      code: "result-window-unavailable" as const,
                      message: "The result window request was disconnected.",
                    };
                  }
                  const window = yield* desktopWindow.openThreadWindow(
                    request,
                    alive,
                    resultPresentation,
                  );
                  return {
                    version: 1 as const,
                    requestId: request.requestId,
                    ok: true as const,
                    environmentId: request.environmentId,
                    threadId: request.threadId,
                    windowId: window.id,
                  };
                }),
              ),
            cancel: (requestId) => broker.cancel(requestId),
            onReclaimError: (cause) =>
              void runPromise(
                logWarning("failed to restore the desktop app control socket", { cause }),
              ),
          }),
        catch: (cause) => new DesktopAppActivationStartError({ address: address.address, cause }),
      }),
      (server) =>
        Effect.promise(() => server.close()).pipe(
          Effect.catchCause((cause) =>
            logWarning("failed to close the desktop app control socket", { cause }),
          ),
          Effect.ensuring(Effect.sync(() => broker.close())),
        ),
    ).pipe(Effect.asVoid),
    setRendererReady: Effect.fn("DesktopAppActivation.setRendererReady")(function* (ready) {
      if (!ready) {
        clearRegisteredRenderer();
        return;
      }
      const main = yield* electronWindow.main;
      if (Option.isNone(main)) return;
      const webContents = main.value.webContents;
      if (webContents.isDestroyed()) return;

      if (registeredWebContents !== webContents) {
        clearRegisteredRenderer();
        registeredWebContents = webContents;
        const onUnavailable = () => clearRegisteredRenderer();
        const onNavigation = (
          event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
        ) => {
          if (event.isMainFrame && !event.isSameDocument) clearRegisteredRenderer();
        };
        webContents.on("did-start-navigation", onNavigation);
        webContents.once("destroyed", onUnavailable);
        detachRendererListeners = () => {
          webContents.removeListener("did-start-navigation", onNavigation);
          webContents.removeListener("destroyed", onUnavailable);
        };
      }

      broker.registerRenderer((request) => {
        webContents.send(DESKTOP_APP_ACTIVATION_REQUEST_CHANNEL, request);
      });
    }),
    complete: (response) => Effect.sync(() => broker.complete(response)),
  });
});

export const layer = Layer.effect(DesktopAppActivation, make);

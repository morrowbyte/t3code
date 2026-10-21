import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CuaControl from "./CuaControl.ts";
import * as CuaDriverHost from "./CuaDriverHost.ts";
import * as CuaInstallation from "./CuaInstallation.ts";
import * as CuaNativeSdk from "./CuaNativeSdk.ts";

const controlLayer = CuaControl.layer.pipe(
  Layer.provide(
    CuaDriverHost.layerEmbedded.pipe(
      Layer.provide(CuaNativeSdk.layer.pipe(Layer.provide(CuaInstallation.layer))),
    ),
  ),
  Layer.provide(ServerEnvironment.layerIdentity),
);

const reconcile = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const control = yield* CuaControl.CuaControl;
  const { environmentId } = yield* control.status;
  const changes = yield* settings.subscribeChanges;
  const initial = yield* settings.getSettings;
  const update = (enabled: boolean) =>
    control
      .setEnabled({ environmentId, enabled })
      .pipe(Effect.catch((cause) => Effect.logError("Windows CUA configuration failed", cause)));
  yield* update(initial.enableWindowsCua);
  yield* changes.pipe(
    Stream.map((value) => value.enableWindowsCua),
    Stream.changes,
    Stream.runForEach(update),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(reconcile).pipe(Layer.provideMerge(controlLayer));

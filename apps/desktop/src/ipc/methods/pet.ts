// @effect-diagnostics nodeBuiltinImport:off -- The native companion keeps its imported assets beside desktop settings.
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as Electron from "electron";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { DesktopPetProjection, DesktopPetSettings, DesktopPetStatus } from "@t3tools/contracts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { PetCompanion } from "../../pet/PetCompanion.ts";
import { importPetPack } from "../../pet/PetPack.ts";
import { hasGlobalShortcutsPortal } from "../../pet/PetShortcut.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class PetAccessError extends Schema.TaggedError<PetAccessError>()("PetAccessError", {}) {}

export const installPet = Effect.fn("desktop.pet.install")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  const windows = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const mutex = yield* Semaphore.make(1);
  const directory = NodePath.join(environment.stateDir, "pet");
  let renderer: Electron.WebContents | null = null;
  let shortcut = "";
  let stopped = false;
  const pet = new PetCompanion(directory, (event) => {
    if (renderer && !renderer.isDestroyed()) renderer.send(Channels.PET_EVENT_CHANNEL, event);
  });
  const syncShortcut = async () => {
    const requested = pet.status.settings.shortcut;
    if (requested && requested === shortcut) return;
    if (shortcut) Electron.globalShortcut.unregister(shortcut);
    shortcut = "";
    pet.setShortcutRegistered(false);
    if (
      requested &&
      NodeProcess.platform === "linux" &&
      (NodeProcess.env.WAYLAND_DISPLAY || NodeProcess.env.XDG_SESSION_TYPE === "wayland") &&
      !(await hasGlobalShortcutsPortal().catch(() => false))
    )
      return;
    if (stopped) return;
    let registered = false;
    if (requested) {
      try {
        registered = Electron.globalShortcut.register(requested, () => pet.toggle());
      } catch {}
      if (registered) shortcut = requested;
    }
    pet.setShortcutRegistered(registered);
  };
  const authorize = Effect.fn("desktop.pet.authorize")(function* (
    event?: DesktopIpc.DesktopIpcInvokeEvent,
  ) {
    const main = Option.getOrNull(yield* windows.main);
    if (
      !main ||
      !event ||
      event.sender.id !== main.webContents.id ||
      event.senderFrame?.parent !== null ||
      event.senderFrame.processId !== main.webContents.mainFrame.processId ||
      event.senderFrame.routingId !== main.webContents.mainFrame.routingId
    ) {
      return yield* new PetAccessError();
    }
    if (renderer !== main.webContents) {
      renderer = main.webContents;
      renderer.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) pet.resetProjection();
      });
      renderer.once("destroyed", () => {
        renderer = null;
        pet.resetProjection();
      });
    }
    return main;
  });
  const initialize = () => Effect.tryPromise(() => pet.load()).pipe(Effect.orDie);
  yield* initialize();
  yield* Effect.promise(syncShortcut);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      stopped = true;
      if (shortcut) Electron.globalShortcut.unregister(shortcut);
      pet.stop();
    }),
  );

  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_GET_STATUS_CHANNEL,
      payload: Schema.Void,
      result: DesktopPetStatus,
      handler: Effect.fn("desktop.pet.status")(function* (_input, event) {
        yield* authorize(event);
        return pet.status;
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_SET_SETTINGS_CHANNEL,
      payload: DesktopPetSettings,
      payloadDecodeOptions: { onExcessProperty: "error" },
      result: DesktopPetStatus,
      handler: Effect.fn("desktop.pet.configure")(function* (settings, event) {
        yield* authorize(event);
        return yield* mutex.withPermits(1)(
          Effect.tryPromise(async () => {
            await pet.configure(settings);
            await syncShortcut();
            return pet.status;
          }),
        );
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_RECONNECT_CHANNEL,
      payload: Schema.Void,
      result: DesktopPetStatus,
      handler: Effect.fn("desktop.pet.reconnect")(function* (_input, event) {
        yield* authorize(event);
        return yield* mutex.withPermits(1)(Effect.tryPromise(() => pet.reconnect()));
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_SET_PROJECTION_CHANNEL,
      payload: DesktopPetProjection,
      payloadDecodeOptions: { onExcessProperty: "error" },
      result: Schema.Void,
      handler: Effect.fn("desktop.pet.project")(function* (projection, event) {
        yield* authorize(event);
        pet.setProjection(projection);
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_TOGGLE_CHANNEL,
      payload: Schema.Void,
      result: Schema.Void,
      handler: Effect.fn("desktop.pet.toggle")(function* (_input, event) {
        yield* authorize(event);
        pet.toggle();
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_IMPORT_CHANNEL,
      payload: Schema.Void,
      result: DesktopPetStatus,
      handler: Effect.fn("desktop.pet.import")(function* (_input, event) {
        const owner = yield* authorize(event);
        return yield* mutex.withPermits(1)(
          Effect.tryPromise(async () => {
            const selected = await Electron.dialog.showOpenDialog(owner, {
              title: "Import animated pet",
              properties: ["openDirectory"],
            });
            if (!selected.canceled && selected.filePaths[0]) {
              const pack = await importPetPack(
                selected.filePaths[0],
                directory,
                (png, width, height) => {
                  const image = Electron.nativeImage.createFromBuffer(png);
                  const size = image.getSize();
                  return !image.isEmpty() && size.width === width && size.height === height;
                },
              );
              await pet.selectPet(pack.path, pack.name);
            }
            return pet.status;
          }),
        );
      }),
    }),
  );
  yield* ipc.handle(
    DesktopIpc.makeIpcMethod({
      channel: Channels.PET_RESET_CHANNEL,
      payload: Schema.Void,
      result: DesktopPetStatus,
      handler: Effect.fn("desktop.pet.reset")(function* (_input, event) {
        yield* authorize(event);
        return yield* mutex.withPermits(1)(
          Effect.tryPromise(async () => {
            await pet.selectPet(null, null);
            return pet.status;
          }),
        );
      }),
    }),
  );
});

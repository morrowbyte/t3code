import { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setReady = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_READY_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.setReady")(function* (ready, event) {
    const windows = yield* ElectronWindow.ElectronWindow;
    const main = yield* windows.main;
    if (
      Option.isNone(main) ||
      main.value.isDestroyed() ||
      main.value.webContents.isDestroyed() ||
      event?.sender !== main.value.webContents ||
      event.senderFrame !== main.value.webContents.mainFrame
    )
      return;
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.setRendererReady(ready);
  }),
});

export const complete = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.DESKTOP_APP_ACTIVATION_COMPLETE_CHANNEL,
  payload: DesktopAppActivationResponse,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.appActivation.complete")(function* (response, event) {
    const windows = yield* ElectronWindow.ElectronWindow;
    const main = yield* windows.main;
    if (
      Option.isNone(main) ||
      main.value.isDestroyed() ||
      main.value.webContents.isDestroyed() ||
      event?.sender !== main.value.webContents ||
      event.senderFrame !== main.value.webContents.mainFrame
    )
      return;
    const activation = yield* DesktopAppActivation.DesktopAppActivation;
    yield* activation.complete(response);
  }),
});

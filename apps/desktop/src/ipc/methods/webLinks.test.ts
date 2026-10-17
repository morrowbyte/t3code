import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopWebLinks from "../../app/DesktopWebLinks.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type { DesktopIpcInvokeEvent } from "../DesktopIpc.ts";
import { setReady } from "./webLinks.ts";

function makeWindow(id: number) {
  let windowDestroyed = false;
  let contentsDestroyed = false;
  const webContents = {
    id,
    mainFrame: { processId: id * 10, routingId: 1, parent: null },
    isDestroyed: () => contentsDestroyed,
  };
  return {
    window: {
      webContents,
      isDestroyed: () => windowDestroyed,
    } as unknown as Electron.BrowserWindow,
    event: { sender: webContents, senderFrame: webContents.mainFrame },
    destroyWindow: () => {
      windowDestroyed = true;
    },
    destroyContents: () => {
      contentsDestroyed = true;
    },
  };
}

describe("web link IPC ownership", () => {
  it.effect(
    "prevents a second window or subframe from registering or clearing the main listener",
    () =>
      Effect.gen(function* () {
        const main = makeWindow(7);
        const result = makeWindow(8);
        const ready: boolean[] = [];
        const layer = Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main.window) }),
          Layer.mock(DesktopWebLinks.DesktopWebLinks)({
            setRendererReady: (value) =>
              Effect.sync(() => {
                ready.push(value);
              }),
          }),
        );
        const rejected: Array<DesktopIpcInvokeEvent | undefined> = [
          undefined,
          result.event,
          { sender: { id: main.event.sender.id }, senderFrame: main.event.senderFrame },
          { sender: main.event.sender },
          { sender: main.event.sender, senderFrame: { ...main.event.senderFrame } },
          { sender: main.event.sender, senderFrame: { ...main.event.senderFrame, parent: {} } },
        ];
        yield* Effect.gen(function* () {
          yield* setReady.handler(true, main.event);
          for (const event of rejected) {
            yield* setReady.handler(false, event);
            yield* setReady.handler(true, event);
          }
          assert.deepEqual(ready, [true]);
          yield* setReady.handler(false, main.event);
          assert.deepEqual(ready, [true, false]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("requires a live current registered main instead of a fallback or previous main", () =>
    Effect.gen(function* () {
      const old = makeWindow(7);
      const current = makeWindow(8);
      const destroyedWindow = makeWindow(9);
      destroyedWindow.destroyWindow();
      const destroyedContents = makeWindow(10);
      destroyedContents.destroyContents();
      const registered = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const ready: boolean[] = [];
      const layer = Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Ref.get(registered),
          currentMainOrFirst: Effect.die("must not use a fallback window"),
          focusedMainOrFirst: Effect.die("must not use a focused window"),
        }),
        Layer.mock(DesktopWebLinks.DesktopWebLinks)({
          setRendererReady: (value) =>
            Effect.sync(() => {
              ready.push(value);
            }),
        }),
      );
      yield* Effect.gen(function* () {
        yield* setReady.handler(false, old.event);
        for (const target of [destroyedWindow, destroyedContents]) {
          yield* Ref.set(registered, Option.some(target.window));
          yield* setReady.handler(true, target.event);
        }
        yield* Ref.set(registered, Option.some(current.window));
        yield* setReady.handler(false, old.event);
        assert.deepEqual(ready, []);
        yield* setReady.handler(true, current.event);
        assert.deepEqual(ready, [true]);
      }).pipe(Effect.provide(layer));
    }),
  );
});

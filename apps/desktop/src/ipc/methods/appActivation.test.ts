import { assert, describe, it } from "@effect/vitest";
import type { DesktopAppActivationResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as DesktopAppActivation from "../../app/DesktopAppActivation.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import type { DesktopIpcInvokeEvent } from "../DesktopIpc.ts";
import { complete, setReady } from "./appActivation.ts";

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

const response: DesktopAppActivationResponse = {
  version: 1,
  requestId: "activation-1",
  ok: false,
  code: "thread-open-failed",
  message: "Could not open the thread.",
};

describe("app activation IPC ownership", () => {
  it.effect(
    "keeps second-window cleanup and foreign completion away from the main activation",
    () =>
      Effect.gen(function* () {
        const main = makeWindow(7);
        const result = makeWindow(8);
        const ready: boolean[] = [];
        const completed: DesktopAppActivationResponse[] = [];
        const layer = Layer.mergeAll(
          Layer.mock(ElectronWindow.ElectronWindow)({ main: Effect.succeedSome(main.window) }),
          Layer.mock(DesktopAppActivation.DesktopAppActivation)({
            setRendererReady: (value) =>
              Effect.sync(() => {
                ready.push(value);
              }),
            complete: (value) =>
              Effect.sync(() => {
                completed.push(value);
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
            yield* complete.handler(response, event);
          }
          assert.deepEqual(ready, [true]);
          assert.deepEqual(completed, []);
          yield* complete.handler(response, main.event);
          yield* setReady.handler(false, main.event);
          assert.deepEqual(ready, [true, false]);
          assert.deepEqual(completed, [response]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("requires a live current registered main, including after main replacement", () =>
    Effect.gen(function* () {
      const old = makeWindow(7);
      const current = makeWindow(8);
      const destroyedWindow = makeWindow(9);
      destroyedWindow.destroyWindow();
      const destroyedContents = makeWindow(10);
      destroyedContents.destroyContents();
      const registered = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
      const accepted: string[] = [];
      const layer = Layer.mergeAll(
        Layer.mock(ElectronWindow.ElectronWindow)({
          main: Ref.get(registered),
          currentMainOrFirst: Effect.die("must not use a fallback window"),
          focusedMainOrFirst: Effect.die("must not use a focused window"),
        }),
        Layer.mock(DesktopAppActivation.DesktopAppActivation)({
          setRendererReady: () =>
            Effect.sync(() => {
              accepted.push("ready");
            }),
          complete: () =>
            Effect.sync(() => {
              accepted.push("complete");
            }),
        }),
      );
      yield* Effect.gen(function* () {
        yield* setReady.handler(false, old.event);
        yield* complete.handler(response, old.event);
        for (const target of [destroyedWindow, destroyedContents]) {
          yield* Ref.set(registered, Option.some(target.window));
          yield* setReady.handler(true, target.event);
          yield* complete.handler(response, target.event);
        }
        yield* Ref.set(registered, Option.some(current.window));
        yield* setReady.handler(false, old.event);
        yield* complete.handler(response, old.event);
        assert.deepEqual(accepted, []);
        yield* setReady.handler(true, current.event);
        yield* complete.handler(response, current.event);
        assert.deepEqual(accepted, ["ready", "complete"]);
      }).pipe(Effect.provide(layer));
    }),
  );
});

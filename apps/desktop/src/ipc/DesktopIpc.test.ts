import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

function makeIpcMain(
  overrides: Partial<DesktopIpc.DesktopIpcMain> = {},
): DesktopIpc.DesktopIpcMain {
  return {
    removeHandler: vi.fn(),
    handle: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("DesktopIpc", () => {
  it.effect("forwards the invoke sender to the method", () =>
    Effect.gen(function* () {
      let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
      const ipc = DesktopIpc.make(
        makeIpcMain({
          handle: (_channel, registered) => {
            listener = registered;
          },
        }),
        () => Effect.succeed(true),
      );
      const sender = { sender: { id: 7 } };
      let received: DesktopIpc.DesktopIpcInvokeEvent | undefined;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ipc.handle({
            channel: "desktop.test.sender",
            handler: (_raw, event) =>
              Effect.sync(() => {
                received = event;
              }),
          });
          yield* Effect.promise(async () => listener!(sender, undefined));
        }),
      );

      assert.strictEqual(received, sender);
    }),
  );
});

describe("DesktopIpc payload decoding options", () => {
  const payload = Schema.Struct({
    label: Schema.String,
    child: Schema.Struct({ allowed: Schema.Boolean }),
  });
  it.effect("strict opt-in rejects top-level and nested excess properties before the handler", () =>
    Effect.gen(function* () {
      let calls = 0;
      const method = DesktopIpc.makeIpcMethod({
        channel: "desktop.test.strict-payload",
        payload,
        result: Schema.Boolean,
        payloadDecodeOptions: { onExcessProperty: "error" },
        handler: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
      });
      assert.equal(yield* method.handler({ label: "owned", child: { allowed: true } }), true);
      assert.equal(calls, 1);
      const top = yield* method
        .handler({ label: "owned", child: { allowed: true }, rawSettings: "refused" })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(top));
      assert.equal(calls, 1);
      const nested = yield* method
        .handler({ label: "owned", child: { allowed: true, rawSettings: "refused" } })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(nested));
      assert.equal(calls, 1);
    }),
  );
  it.effect("absent options preserve legacy excess-field stripping and handler behavior", () =>
    Effect.gen(function* () {
      let observed: typeof payload.Type | undefined;
      const method = DesktopIpc.makeIpcMethod({
        channel: "desktop.test.legacy-payload",
        payload,
        result: Schema.Boolean,
        handler: (input) =>
          Effect.sync(() => {
            observed = input;
            return true;
          }),
      });
      assert.equal(
        yield* method.handler({
          label: "owned",
          child: { allowed: true, extra: "legacy" },
          extra: "legacy",
        }),
        true,
      );
      assert.deepEqual(observed, { label: "owned", child: { allowed: true } });
    }),
  );
});

it.effect("answers only the main window's top frame", () =>
  Effect.gen(function* () {
    const mainFrame = { processId: 1, routingId: 1, parent: null };
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: {
        sender: { id: 1 },
        senderFrame: { processId: 1, routingId: 2, parent: mainFrame },
      },
      previewGuest: {
        sender: { id: 2 },
        senderFrame: { processId: 1, routingId: 2, parent: mainFrame },
      },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }),
);

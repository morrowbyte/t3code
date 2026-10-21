import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

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

// @effect-diagnostics nodeBuiltinImport:off -- The portal transport is an event emitter.
import * as NodeEvents from "node:events";
import { DBusError, Message, MessageType, Variant, type MessageBus } from "dbus-next";
import { expect, it, vi } from "vite-plus/test";
import { hasGlobalShortcutsPortal } from "./PetShortcut.ts";

it.each([
  { version: new Variant("u", 1), available: true },
  { version: new Variant("u", 2), available: true },
  { version: new Variant("u", 0), available: false },
  { version: new Variant("s", "1"), available: false },
  { version: null, available: false },
])("validates the shortcut portal version $version", async ({ version, available }) => {
  const bus = Object.assign(new NodeEvents.EventEmitter(), {
    call: async () =>
      new Message({ type: MessageType.METHOD_RETURN, replySerial: "1", body: [version] }),
    disconnect: vi.fn(),
  });
  expect(await hasGlobalShortcutsPortal(bus as unknown as MessageBus)).toBe(available);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

it("reports unavailable when the desktop exports no shortcut interface", async () => {
  const bus = Object.assign(new NodeEvents.EventEmitter(), {
    call: async () => {
      throw new DBusError("org.freedesktop.DBus.Error.UnknownInterface", "");
    },
    disconnect: vi.fn(),
  });
  expect(await hasGlobalShortcutsPortal(bus as unknown as MessageBus)).toBe(false);
  expect(bus.disconnect).toHaveBeenCalledOnce();
});

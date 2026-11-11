// @effect-diagnostics globalTimers:off -- The optional desktop portal probe has a bounded deadline.
import { Message, MessageType, Variant, sessionBus, type MessageBus } from "dbus-next";

export async function hasGlobalShortcutsPortal(bus: MessageBus = sessionBus()) {
  const failed = Promise.withResolvers<never>();
  bus.on("error", failed.reject);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const reply = await Promise.race([
      bus.call(
        new Message({
          destination: "org.freedesktop.portal.Desktop",
          path: "/org/freedesktop/portal/desktop",
          interface: "org.freedesktop.DBus.Properties",
          member: "Get",
          signature: "ss",
          body: ["org.freedesktop.portal.GlobalShortcuts", "version"],
        }),
      ),
      failed.promise,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("portal-unavailable")), 2_000);
      }),
    ]);
    const version: unknown = reply?.body[0];
    return (
      reply?.type === MessageType.METHOD_RETURN &&
      version instanceof Variant &&
      version.signature === "u" &&
      Number.isInteger(version.value) &&
      version.value >= 1
    );
  } catch {
    return false;
  } finally {
    clearTimeout(deadline);
    bus.disconnect();
  }
}

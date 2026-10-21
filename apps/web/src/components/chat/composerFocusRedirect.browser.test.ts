import { describe, expect, it } from "vite-plus/test";

import { shouldTypeToFocusComposer } from "./composerFocusRedirect";
import { leaveNavigationMode, requestNavigationMode } from "../keyboard/navigationMode";
import { render } from "../../../test/render";

// composedPath() is only populated while the event is dispatching, so decide
// inside a window capture listener the way the chat view does.
function typeOn(target: Element, key: string): boolean {
  let redirected = false;
  const listener = (event: KeyboardEvent) => {
    redirected = shouldTypeToFocusComposer(event);
  };
  window.addEventListener("keydown", listener, { capture: true });
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true }));
  window.removeEventListener("keydown", listener, { capture: true });
  return redirected;
}

function setup(): Disposable {
  leaveNavigationMode();
  return { [Symbol.dispose]: leaveNavigationMode };
}

describe("shouldTypeToFocusComposer", () => {
  it("keeps local panel navigation and shadow-tree keys out of the composer", async () => {
    using _navigation = setup();
    await using screen = await render(null);
    const panel = document.createElement("div");
    panel.dataset.keyboardLocal = "true";
    const tree = panel.attachShadow({ mode: "open" });
    const row = document.createElement("div");
    tree.append(row);
    screen.container.append(panel);
    expect(typeOn(row, "j")).toBe(false);
    expect(typeOn(row, "/")).toBe(false);
  });
  it("keeps printable keys in explicit navigation until compose is requested", async () => {
    using _navigation = setup();
    await using screen = await render(null);
    const chat = document.createElement("div");
    screen.container.append(chat);
    requestNavigationMode();
    expect(typeOn(chat, "a")).toBe(false);
    leaveNavigationMode();
    expect(typeOn(chat, "a")).toBe(true);
  });
  it("sends letters typed on the chat to the composer", async () => {
    using _navigation = setup();
    await using screen = await render(null);
    const chat = document.createElement("div");
    screen.container.append(chat);

    expect(typeOn(chat, "a")).toBe(true);
  });

  it("keeps letters typed on the device screen on the device", async () => {
    using _navigation = setup();
    await using screen = await render(null);
    const deviceScreen = document.createElement("div");
    deviceScreen.setAttribute("role", "application");
    deviceScreen.tabIndex = 0;
    screen.container.append(deviceScreen);

    expect(typeOn(deviceScreen, "a")).toBe(false);
  });
});

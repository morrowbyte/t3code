import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { DeviceControlsRail } from "./DeviceControlsRail";

it("moves through device controls and activates the selected hardware control by keyboard", async () => {
  const pressButton = vi.fn();
  const noop = () => {};
  await using screen = await render(
    <DeviceControlsRail
      platform="android"
      handle={{ inputConnected: true, pressButton, rotate: noop }}
      view={{
        handle: null,
        phone: false,
        streaming: true,
        phoneUnavailableReason: null,
        showPhone: noop,
        showFlat: noop,
        resetView: noop,
        keyboard: null,
      }}
      controls={{
        detail: null,
        pending: false,
        error: null,
        disabled: true,
        foregroundApp: null,
        act: async () => {},
      }}
      screenshotPending={false}
      onScreenshot={noop}
      toolsOpen={false}
      onTools={noop}
      onFloat={noop}
      onClose={noop}
      onPowerOff={noop}
    />,
  );
  screen.container.querySelector<HTMLButtonElement>('button[aria-label="Home"]')!.focus();
  await userEvent.keyboard("j");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Back");
  await userEvent.keyboard("{Enter}");
  expect(pressButton).toHaveBeenCalledExactlyOnceWith("back");
  await userEvent.keyboard("{Home}");
  expect(document.activeElement?.getAttribute("aria-label")).toBe("Home");
});

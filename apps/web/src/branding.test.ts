// @effect-diagnostics-next-line nodeBuiltinImport:off - Reads the static install manifest as a test fixture.
import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  resolveServerBackedAppDisplayName,
  resolveServerBackedAppStageLabel,
} from "./branding.logic";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("branding", () => {
  it("uses Crew Web in an ordinary browser", async () => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    const branding = await import("./branding");
    expect(branding.APP_BASE_NAME).toBe("Crew Web");
    expect(branding.APP_DISPLAY_NAME).toBe("Crew Web");
  });

  it("uses Crew when a native bridge has no injected branding", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { desktopBridge: {} },
    });
    const branding = await import("./branding");
    expect(branding.APP_BASE_NAME).toBe("Crew");
    expect(branding.APP_DISPLAY_NAME).toBe("Crew");
  });

  it("uses injected desktop branding when available", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {
          getAppBranding: () => ({
            baseName: "T3 Code",
            stageLabel: "Nightly",
            displayName: "T3 Code (Nightly)",
          }),
        },
      },
    });

    const branding = await import("./branding");

    expect(branding.APP_BASE_NAME).toBe("T3 Code");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("T3 Code (Nightly)");
  });

  it("normalizes hosted app channel metadata", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "nightly");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("nightly");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Nightly");
    expect(branding.APP_STAGE_LABEL).toBe("Nightly");
    expect(branding.APP_DISPLAY_NAME).toBe("Crew Web");
  });

  it("does not label the latest hosted app channel", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "latest");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBe("latest");
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBe("Latest");
    expect(branding.APP_STAGE_LABEL).toBe("Latest");
    expect(branding.APP_DISPLAY_NAME).toBe("Crew Web");
  });

  it("ignores unknown hosted app channels", async () => {
    vi.stubEnv("VITE_HOSTED_APP_CHANNEL", "preview");

    const branding = await import("./branding");

    expect(branding.HOSTED_APP_CHANNEL).toBeNull();
    expect(branding.HOSTED_APP_CHANNEL_LABEL).toBeNull();
  });
});

describe("branding logic", () => {
  it("keeps the Crew Web label stable with a nightly server", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Crew Web",
        fallbackDisplayName: "Crew Web",
        fallbackStageLabel: "Latest",
        primaryServerVersion: "0.1.2-nightly.20261026.1",
      }),
    ).toBe("Crew Web");
  });

  it("keeps the installed Crew label stable when a nightly server connects", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "Crew",
        fallbackDisplayName: "Crew",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.47-nightly.20261014.15",
      }),
    ).toBe("Crew");
  });

  it("returns Nightly for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppStageLabel({
        primaryServerVersion: "0.0.28-nightly.20260616.12",
        fallbackStageLabel: "Alpha",
      }),
    ).toBe("Nightly");
  });

  it("updates the display name for nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616.12",
      }),
    ).toBe("T3 Code (Nightly)");
  });

  it("keeps the fallback display name for stable primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.27",
      }),
    ).toBe("T3 Code (Alpha)");
  });

  it("keeps the fallback display name for malformed nightly primary server versions", () => {
    expect(
      resolveServerBackedAppDisplayName({
        baseName: "T3 Code",
        fallbackDisplayName: "T3 Code (Alpha)",
        fallbackStageLabel: "Alpha",
        primaryServerVersion: "0.0.28-nightly.20260616",
      }),
    ).toBe("T3 Code (Alpha)");
  });
});

describe("browser install branding", () => {
  it("keeps the existing installed app identity with Crew Web icons", () => {
    const manifest = JSON.parse(
      NodeFS.readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    );
    expect(manifest).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      name: "Crew Web",
      short_name: "Crew Web",
    });
    expect(manifest.icons).toEqual([
      { src: "/crew-web.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/crew-web-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/crew-web-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ]);
  });

  it("uses the browser-frame icon for browser and Apple install entry points", () => {
    const html = NodeFS.readFileSync(new URL("../index.html", import.meta.url), "utf8");
    expect(html).toContain('rel="icon" href="/crew-web.ico"');
    expect(html).toContain('rel="icon" type="image/svg+xml" href="/crew-web.svg"');
    expect(html).toContain('rel="apple-touch-icon" href="/crew-web-192.png"');
  });
});

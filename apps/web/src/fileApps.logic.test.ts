import { describe, expect, it } from "vite-plus/test";

import { fileAppsForPath } from "./fileApps.logic";
import type { RemoteOpenResolution } from "./remoteOpen";

describe("fileAppsForPath", () => {
  const local = { isResolved: true, state: { mode: "local-exec" } } as const;
  const apps = ["default", "obsidian"] as const;

  it.each(["Bericht.xlsx", "Brief.docx", "Anlage.pdf", "src/index.ts"])(
    "offers the OS association for %s without treating Obsidian as an editor",
    (path) => expect(fileAppsForPath(apps, local, path)).toEqual(["default"]),
  );

  it.each(["Notizen/Änderung.md:12:3", "Plan.excalidraw", "Plan.excalidraw.md", "NOTE.MD"])(
    "offers installed Obsidian for %s after separating the position",
    (path) => expect(fileAppsForPath(apps, local, path)).toEqual(apps),
  );

  it.each<RemoteOpenResolution>([
    { isResolved: false, state: { mode: "local-exec" } },
    {
      isResolved: true,
      state: { mode: "remote-links", host: { kind: "ssh-alias", host: "server" } },
    },
    { isResolved: true, state: { mode: "remote-unavailable" } },
  ])("does not offer local file apps for remote or unresolved environments: %j", (remote) => {
    expect(fileAppsForPath(apps, remote, "C:\\Vault\\Notiz.md")).toEqual([]);
  });

  it("does not advertise apps absent from server discovery, including older servers", () => {
    expect(fileAppsForPath(["default"], local, "/vault/Notiz.md")).toEqual(["default"]);
    expect(fileAppsForPath([], local, "/vault/Notiz.md")).toEqual([]);
  });
});

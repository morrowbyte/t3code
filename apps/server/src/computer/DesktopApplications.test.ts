import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopApplications from "./DesktopApplications.ts";
import { parseDesktopEntry } from "./desktopEntries.ts";

it("keeps desktop action metadata without interpreting Exec as a shell command", () => {
  const parsed = parseDesktopEntry(
    "org.example.Browser.desktop",
    `[Desktop Entry]
Type=Application
Name=Browser
Name[de]=Netz\\sBrowser
Exec=/usr/bin/flatpak run --file-forwarding org.example.Browser @@u %U @@
X-Flatpak=org.example.Browser
Actions=new-window;private;
MimeType=x-scheme-handler/https;
Categories=Network;Qt;
Terminal=false
[Desktop Action private]
Name=Private window
Exec=ignored
`,
    "de_DE",
  );
  expect(parsed).toMatchObject({
    application: {
      id: "org.example.Browser.desktop",
      name: "Netz Browser",
      executable: "flatpak",
      flatpakId: "org.example.Browser",
      desktopActions: ["new-window", "private"],
      browser: true,
      toolkitHint: "qt",
      terminal: false,
    },
  });
});

it.effect("respects user tombstones, nested desktop IDs and unavailable TryExec", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-computer-apps-" });
    const user = path.join(home, "user/applications");
    const system = path.join(home, "system/applications");
    yield* fs.makeDirectory(user, { recursive: true });
    yield* fs.makeDirectory(path.join(system, "editors"), { recursive: true });
    const entry = (name: string, extra = "") =>
      `[Desktop Entry]\nType=Application\nName=Acme ${name}\nExec=acme\n${extra}`;
    yield* fs.writeFileString(path.join(system, "browser.desktop"), entry("browser"));
    yield* fs.writeFileString(path.join(user, "browser.desktop"), "[Desktop Entry]\nHidden=true\n");
    yield* fs.writeFileString(
      path.join(system, "editors/editor.desktop"),
      entry("editor", "Terminal=true\n"),
    );
    yield* fs.writeFileString(
      path.join(system, "missing.desktop"),
      entry("missing", "TryExec=/does-not-exist/t3-computer-test\n"),
    );
    yield* fs.writeFileString(
      path.join(system, "hidden.desktop"),
      entry("hidden", "NoDisplay=true\n"),
    );
    const layer = DesktopApplications.layer.pipe(
      Layer.provide(Layer.succeed(HostProcess.Platform, "linux")),
      Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
      Layer.provide(
        Layer.succeed(HostProcess.Environment, {
          XDG_DATA_HOME: path.join(home, "user"),
          XDG_DATA_DIRS: path.join(home, "system"),
        }),
      ),
    );
    const apps = yield* DesktopApplications.DesktopApplications.pipe(Effect.provide(layer));
    const visible = yield* apps.list({ query: "Acme" });
    expect(visible.applications.map((app) => app.id)).toEqual(["editors-editor.desktop"]);
    expect(visible.applications[0]?.terminal).toBe(true);
    const withHidden = yield* apps.list({ query: "Acme", includeHidden: true, limit: 1 });
    expect(withHidden.total).toBe(2);
    expect(withHidden.complete).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports an unsupported platform without reading the Linux catalog", () =>
  Effect.gen(function* () {
    const apps = yield* DesktopApplications.DesktopApplications;
    expect(yield* apps.list({})).toEqual({
      platform: "win32",
      supported: false,
      complete: false,
      applications: [],
      total: 0,
      unreadable: 0,
    });
  }).pipe(
    Effect.provide(
      DesktopApplications.layer.pipe(
        Layer.provide(Layer.succeed(HostProcess.Platform, "win32")),
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);

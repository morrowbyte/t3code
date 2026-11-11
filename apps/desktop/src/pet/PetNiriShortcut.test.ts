// @effect-diagnostics nodeBuiltinImport:off -- Niri fixtures live only in temporary test directories.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it, vi } from "vite-plus/test";
import { PetNiriShortcut, petNiriCommand, petNiriKey } from "./PetNiriShortcut.ts";

async function setup() {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crew-pet-niri-"));
  const configHome = NodePath.join(home, ".config");
  const directory = NodePath.join(configHome, "niri");
  await NodeFSP.mkdir(directory, { recursive: true });
  const configPath = NodePath.join(directory, "config.kdl");
  const path = NodePath.join(directory, "crew-pet.kdl");
  await NodeFSP.writeFile(
    configPath,
    'include "base.kdl"\ninclude optional=true "crew-pet.kdl"\ninclude "later.kdl"\n',
  );
  await NodeFSP.writeFile(NodePath.join(directory, "base.kdl"), "binds { Mod+Q { quit; } }\n");
  await NodeFSP.writeFile(NodePath.join(directory, "later.kdl"), "");
  const validate = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined);
  const options = {
    home,
    configHome,
    configPath,
    identity: "profile-one",
    command: petNiriCommand({ executable: "/opt/crew/crew", home, configHome }),
    validate,
  };
  return {
    home,
    configHome,
    directory,
    configPath,
    path,
    validate,
    options,
    adapter: new PetNiriShortcut(options),
    [Symbol.asyncDispose]: () => NodeFSP.rm(home, { recursive: true, force: true }),
  };
}

it("remaps only its include, keeps profile identity, and restores the disabled state", async () => {
  await using fixture = await setup();
  const before = await NodeFSP.readFile(fixture.configPath, "utf8");
  await fixture.adapter.sync("");
  await expect(NodeFSP.stat(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });
  await fixture.adapter.sync("Control+Alt+P");
  const first = await NodeFSP.readFile(fixture.path, "utf8");
  expect(first).toContain('Ctrl+Alt+P repeat=false allow-when-locked=false { spawn "/usr/bin/env"');
  expect(first).toContain('"/opt/crew/crew" "--toggle-desktop-pet"');
  expect((await NodeFSP.stat(fixture.path)).mode & 0o777).toBe(0o600);
  await new PetNiriShortcut(fixture.options).sync("Ctrl+Alt+P");
  expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe(first);
  await fixture.adapter.sync("Ctrl+Alt+O");
  expect(await NodeFSP.readFile(fixture.path, "utf8")).not.toContain("Ctrl+Alt+P");
  await fixture.adapter.sync("");
  expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe("");
  expect(await NodeFSP.readFile(fixture.configPath, "utf8")).toBe(before);
});

it.each(["base.kdl", "later.kdl"])(
  "refuses conflicting %s without replacing the previous binding",
  async (file) => {
    await using fixture = await setup();
    await fixture.adapter.sync("Ctrl+Alt+O");
    const before = await NodeFSP.readFile(fixture.path, "utf8");
    await NodeFSP.writeFile(
      NodePath.join(fixture.directory, file),
      "binds { Control+Alt+P { quit; } }\n",
    );
    await expect(fixture.adapter.sync("Ctrl+Alt+P")).rejects.toMatchObject({
      code: "niri-shortcut-conflict",
    });
    expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe(before);
  },
);

it.each(["symlink", "another-profile", "manual-edit"])(
  "preserves an include owned by %s",
  async (kind) => {
    await using fixture = await setup();
    await fixture.adapter.sync("Ctrl+Alt+P");
    if (kind === "symlink") {
      await NodeFSP.rename(fixture.path, fixture.path + ".original");
      await NodeFSP.symlink(fixture.path + ".original", fixture.path);
    } else if (kind === "manual-edit") await NodeFSP.appendFile(fixture.path, "// keep this\n");
    const adapter =
      kind === "another-profile"
        ? new PetNiriShortcut({ ...fixture.options, identity: "profile-two" })
        : fixture.adapter;
    const before = await NodeFSP.readFile(fixture.path, "utf8");
    await expect(adapter.sync("")).rejects.toMatchObject({ code: "niri-file-not-owned" });
    expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe(before);
  },
);

it.each(["missing-include", "missing-required", "dynamic-include"])(
  "refuses %s before installing a binding",
  async (kind) => {
    await using fixture = await setup();
    await NodeFSP.writeFile(
      fixture.configPath,
      kind === "missing-include"
        ? "binds {}\n"
        : 'include optional=true "crew-pet.kdl"\n' +
            (kind === "missing-required"
              ? 'include "absent.kdl"\n'
              : 'include "$DYNAMIC/keys.kdl"\n'),
    );
    await expect(fixture.adapter.sync("Ctrl+Alt+P")).rejects.toBeInstanceOf(Error);
    await expect(NodeFSP.stat(fixture.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("detects edits during validation and rolls back a failed Niri reload validation", async () => {
  await using fixture = await setup();
  await fixture.adapter.sync("Ctrl+Alt+O");
  const before = await NodeFSP.readFile(fixture.path, "utf8");
  fixture.validate.mockImplementationOnce(async () => {
    await NodeFSP.appendFile(fixture.configPath, "// changed\n");
  });
  await expect(fixture.adapter.sync("Ctrl+Alt+P")).rejects.toMatchObject({
    code: "niri-config-changed",
  });
  expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe(before);
  fixture.validate.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("invalid"));
  await expect(fixture.adapter.sync("Ctrl+Alt+P")).rejects.toMatchObject({
    code: "niri-validation-failed",
  });
  expect(await NodeFSP.readFile(fixture.path, "utf8")).toBe(before);
  expect((await NodeFSP.readdir(fixture.directory)).some((name) => name.endsWith(".tmp"))).toBe(
    false,
  );
});

it("keeps launch arguments separate and preserves the exact desktop profile", () => {
  const command = petNiriCommand({
    executable: '/opt/Crew "quoted"/crew',
    appPath: "/source/apps/desktop",
    home: "/state/crew",
    configHome: "/config",
    profile: "work",
    devServerUrl: "http://127.0.0.1:5733",
  });
  expect(command).toEqual([
    "/usr/bin/env",
    "-u",
    "ELECTRON_RUN_AS_NODE",
    "-u",
    "T3CODE_DESKTOP_PROFILE",
    "-u",
    "VITE_DEV_SERVER_URL",
    "XDG_CONFIG_HOME=/config",
    "T3CODE_HOME=/state/crew",
    "T3CODE_DESKTOP_PROFILE=work",
    "VITE_DEV_SERVER_URL=http://127.0.0.1:5733",
    '/opt/Crew "quoted"/crew',
    "/source/apps/desktop",
    "--toggle-desktop-pet",
  ]);
  expect(() =>
    petNiriCommand({ executable: "crew", home: "/state", configHome: "/config" }),
  ).toThrow();
});

it.each(["P", "Shift+P", "Ctrl+Ctrl+P", "Ctrl+P; quit", "Ctrl+Return", "Mod+P"])(
  "rejects unsupported accelerator %s",
  (key) => {
    expect(() => petNiriKey(key)).toThrow();
  },
);

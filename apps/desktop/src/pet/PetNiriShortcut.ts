// @effect-diagnostics nodeBuiltinImport:off -- Owns only the optional user-managed Niri pet include.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { readKdlNodes } from "../snapShot/captureConfigKdl.ts";
import { niriConfigIncludes } from "../snapShot/captureConfigEdit.ts";

export const DESKTOP_PET_TOGGLE_ARGUMENT = "--toggle-desktop-pet";
const digest = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");
const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const MODIFIERS: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  super: "Super",
  meta: "Super",
  win: "Super",
};

export class PetNiriShortcutError extends Error {
  readonly code:
    | "niri-shortcut-invalid"
    | "niri-config-unavailable"
    | "niri-include-missing"
    | "niri-shortcut-conflict"
    | "niri-file-not-owned"
    | "niri-config-changed"
    | "niri-validation-failed";
  constructor(
    code:
      | "niri-shortcut-invalid"
      | "niri-config-unavailable"
      | "niri-include-missing"
      | "niri-shortcut-conflict"
      | "niri-file-not-owned"
      | "niri-config-changed"
      | "niri-validation-failed",
  ) {
    super(code);
    this.code = code;
  }
}

export function petNiriKey(input: string) {
  const parts = input.split("+").map((part) => part.trim());
  const key = parts.pop()?.toUpperCase();
  const modifiers = parts.map((part) => MODIFIERS[part.toLowerCase()]);
  if (
    !key ||
    !/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key) ||
    modifiers.some((modifier) => !modifier) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some((modifier) => modifier !== "Shift")
  ) {
    throw new PetNiriShortcutError("niri-shortcut-invalid");
  }
  return [
    ...["Ctrl", "Alt", "Shift", "Super"].filter((modifier) => modifiers.includes(modifier)),
    key,
  ].join("+");
}

export function petNiriCommand(input: {
  executable: string;
  appPath?: string;
  configHome: string;
  home: string;
  profile?: string | undefined;
  devServerUrl?: string | undefined;
}) {
  if (
    ![
      input.executable,
      input.configHome,
      input.home,
      ...(input.appPath ? [input.appPath] : []),
    ].every(NodePath.isAbsolute)
  )
    throw new PetNiriShortcutError("niri-config-unavailable");
  return [
    "/usr/bin/env",
    "-u",
    "ELECTRON_RUN_AS_NODE",
    "-u",
    "T3CODE_DESKTOP_PROFILE",
    "-u",
    "VITE_DEV_SERVER_URL",
    `XDG_CONFIG_HOME=${input.configHome}`,
    `T3CODE_HOME=${input.home}`,
    ...(input.profile ? [`T3CODE_DESKTOP_PROFILE=${input.profile}`] : []),
    ...(input.devServerUrl ? [`VITE_DEV_SERVER_URL=${input.devServerUrl}`] : []),
    input.executable,
    ...(input.appPath ? [input.appPath] : []),
    DESKTOP_PET_TOGGLE_ARGUMENT,
  ];
}

function conflicts(source: string, requested: string) {
  return readKdlNodes(source)
    .filter((node) => node.name === "binds")
    .some((block) =>
      block.children.some((node) => {
        const parts = node.name.split("+");
        if (parts.at(-1)?.toUpperCase() !== requested.split("+").at(-1)) return false;
        // Mod defaults differ between native and nested Niri; either possible collision is refused.
        return ["Super", "Alt"].some((mod) => {
          try {
            return (
              petNiriKey(
                parts.map((part) => (part.toLowerCase() === "mod" ? mod : part)).join("+"),
              ) === requested
            );
          } catch {
            return true;
          }
        });
      }),
    );
}

async function readFile(path: string, owned = false) {
  const resolved = owned ? path : await NodeFSP.realpath(path);
  const file = await NodeFSP.open(
    resolved,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > (owned ? 16_384 : 1_048_576) ||
      (owned && stat.uid !== NodeProcess.getuid?.())
    )
      throw new PetNiriShortcutError(owned ? "niri-file-not-owned" : "niri-config-unavailable");
    const bytes = await file.readFile();
    if (bytes.length > (owned ? 16_384 : 1_048_576))
      throw new PetNiriShortcutError("niri-config-unavailable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new PetNiriShortcutError("niri-config-unavailable");
    return { path, resolved, text, stat };
  } finally {
    await file.close();
  }
}
type Snapshot = Awaited<ReturnType<typeof readFile>>;

export class PetNiriShortcut {
  private readonly path: string;
  private readonly owner: string;
  private readonly options: {
    configHome: string;
    configPath: string;
    home: string;
    identity: string;
    command: readonly string[];
    validate?: (path: string) => Promise<void>;
  };
  constructor(options: PetNiriShortcut["options"]) {
    this.options = options;
    this.path = NodePath.join(options.configHome, "niri", "crew-pet.kdl");
    this.owner = digest(options.identity);
  }

  private async current() {
    const file = await readFile(this.path, true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new PetNiriShortcutError("niri-file-not-owned");
    });
    if (file?.text.trim()) {
      const split = file.text.indexOf("\n");
      const body = file.text.slice(split + 1);
      if (file.text.slice(0, split) !== `// crew-desktop-pet/v1 ${this.owner} ${digest(body)}`)
        throw new PetNiriShortcutError("niri-file-not-owned");
    }
    return file;
  }

  private render(shortcut: string) {
    if (!shortcut) return "";
    if (
      this.options.command.length < 2 ||
      this.options.command.some((arg) => /[\u0000-\u001f\u007f]/.test(arg))
    )
      throw new PetNiriShortcutError("niri-config-unavailable");
    const body = `binds {\n    ${petNiriKey(shortcut)} repeat=false allow-when-locked=false { spawn ${this.options.command.map((arg) => JSON.stringify(arg)).join(" ")}; }\n}\n`;
    return `// crew-desktop-pet/v1 ${this.owner} ${digest(body)}\n${body}`;
  }

  private async tree(shortcut: string) {
    const files: Snapshot[] = [];
    const missing: string[] = [];
    let included = false;
    let total = 0;
    const visit = async (path: string, depth: number) => {
      if (depth >= 10 || files.length >= 64)
        throw new PetNiriShortcutError("niri-config-unavailable");
      const file = await readFile(path);
      if (files.some((item) => item.resolved === file.resolved))
        throw new PetNiriShortcutError("niri-config-unavailable");
      files.push(file);
      total += Buffer.byteLength(file.text);
      if (total > 1_048_576) throw new PetNiriShortcutError("niri-config-unavailable");
      if (conflicts(file.text, shortcut)) throw new PetNiriShortcutError("niri-shortcut-conflict");
      for (const include of niriConfigIncludes(file.text)) {
        if (/[\0$*?[\]]/.test(include.path))
          throw new PetNiriShortcutError("niri-config-unavailable");
        const child = include.path.startsWith("~/")
          ? NodePath.join(this.options.home, include.path.slice(2))
          : NodePath.resolve(NodePath.dirname(path), include.path);
        if (child === this.path) {
          included = true;
          continue;
        }
        try {
          await visit(child, depth + 1);
        } catch (error) {
          if (include.optional && (error as NodeJS.ErrnoException).code === "ENOENT")
            missing.push(child);
          else throw error;
        }
      }
    };
    await visit(this.options.configPath, 0);
    if (!included) throw new PetNiriShortcutError("niri-include-missing");
    return { files, missing };
  }

  private async replace(text: string, expected: Snapshot | null) {
    const current = await this.current();
    if (current?.text !== expected?.text || current?.stat.ino !== expected?.stat.ino)
      throw new PetNiriShortcutError("niri-config-changed");
    const temporary = NodePath.join(
      NodePath.dirname(this.path),
      `.crew-pet-${NodeCrypto.randomUUID()}.tmp`,
    );
    try {
      const file = await NodeFSP.open(temporary, "wx", 0o600);
      try {
        await file.writeFile(text);
        await file.sync();
      } finally {
        await file.close();
      }
      const check = await this.current();
      if (check?.text !== expected?.text || check?.stat.ino !== expected?.stat.ino)
        throw new PetNiriShortcutError("niri-config-changed");
      if (expected) await NodeFSP.rename(temporary, this.path);
      else {
        // Linking publishes the first owner atomically without overwriting a competing profile.
        await NodeFSP.link(temporary, this.path);
      }
    } finally {
      await NodeFSP.rm(temporary, { force: true });
    }
  }

  async sync(shortcut: string) {
    if (!NodePath.isAbsolute(this.options.configPath))
      throw new PetNiriShortcutError("niri-config-unavailable");
    const current = await this.current();
    const next = this.render(shortcut);
    if (!shortcut) {
      if (current?.text.trim()) await this.replace("", current);
      return;
    }
    let tree: Awaited<ReturnType<PetNiriShortcut["tree"]>>;
    try {
      tree = await this.tree(petNiriKey(shortcut));
    } catch (error) {
      if (error instanceof PetNiriShortcutError) throw error;
      throw new PetNiriShortcutError("niri-config-unavailable");
    }
    const validate =
      this.options.validate ??
      (async (path: string) => {
        await execute("niri", ["validate", "--config", path], {
          timeout: 5_000,
          maxBuffer: 64 * 1024,
        });
      });
    try {
      await validate(this.options.configPath);
    } catch {
      throw new PetNiriShortcutError("niri-validation-failed");
    }
    for (const original of tree.files) {
      const now = await readFile(original.path);
      if (
        now.resolved !== original.resolved ||
        now.stat.ino !== original.stat.ino ||
        now.text !== original.text
      )
        throw new PetNiriShortcutError("niri-config-changed");
    }
    for (const path of tree.missing) {
      if (
        await NodeFSP.lstat(path).then(
          () => true,
          (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
        )
      )
        throw new PetNiriShortcutError("niri-config-changed");
    }
    if (current?.text === next) return;
    await this.replace(next, current);
    try {
      await validate(this.options.configPath);
    } catch {
      const written = await this.current();
      if (written?.text === next) await this.replace(current?.text ?? "", written);
      throw new PetNiriShortcutError("niri-validation-failed");
    }
  }
}

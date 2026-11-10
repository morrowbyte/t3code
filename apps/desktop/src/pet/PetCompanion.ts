// @effect-diagnostics nodeBuiltinImport:off -- This adapter owns the native companion process and its private settings file.
// @effect-diagnostics globalTimers:off -- The native protocol handshake has a bounded process watchdog.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import {
  DEFAULT_DESKTOP_PET_SETTINGS,
  DesktopPetSettings,
  type DesktopPetEvent,
  type DesktopPetNativeEvent,
  type DesktopPetProjection,
  type DesktopPetStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createPetDecoder } from "./PetProtocol.ts";

const decodeSettings = Schema.decodeUnknownSync(DesktopPetSettings);
const decodeSettingsValue = Schema.decodeSync(DesktopPetSettings);

const nativeEnvironment = () =>
  Object.fromEntries(
    [
      "PATH",
      "HOME",
      "LANG",
      "LC_ALL",
      "DISPLAY",
      "WAYLAND_DISPLAY",
      "XDG_RUNTIME_DIR",
      "XDG_SESSION_TYPE",
      "DBUS_SESSION_BUS_ADDRESS",
      "NIRI_SOCKET",
    ].flatMap((key) => (NodeProcess.env[key] === undefined ? [] : [[key, NodeProcess.env[key]!]])),
  );

export class PetCompanion {
  private child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private blocked = false;
  private pendingProjection: DesktopPetProjection | null = null;
  private revision = -1;
  private wireRevision = 0;
  private projection: DesktopPetProjection = {
    v: 1,
    type: "projection",
    revision: 0,
    workingCount: 0,
    items: [],
  };
  private petPath: string | null = null;
  private state: DesktopPetStatus = {
    settings: DEFAULT_DESKTOP_PET_SETTINGS,
    connection: NodeProcess.platform === "linux" ? "unavailable" : "unsupported",
    capabilities: null,
    native: null,
    error: null,
    shortcutRegistered: false,
    customPet: null,
  };

  private readonly directory: string;
  private readonly emit: (event: DesktopPetEvent) => void;
  constructor(directory: string, emit: (event: DesktopPetEvent) => void) {
    this.directory = directory;
    this.emit = emit;
  }

  get status(): DesktopPetStatus {
    return this.state;
  }

  private publish(update: Partial<DesktopPetStatus>) {
    this.state = { ...this.state, ...update };
    this.emit({ type: "status", status: this.state });
  }

  async load() {
    try {
      const document = JSON.parse(
        await NodeFSP.readFile(NodePath.join(this.directory, "settings.json"), "utf8"),
      );
      this.state = {
        ...this.state,
        settings: decodeSettings(document),
      };
    } catch {
      /* Missing or invalid settings retain the disabled default. */
    }
    try {
      const selected = await NodeFSP.readFile(
        NodePath.join(this.directory, "selected.json"),
        "utf8",
      );
      const directory = JSON.parse(selected);
      if (typeof directory === "string" && /^pack-[a-f0-9-]{36}$/.test(directory)) {
        const manifest = JSON.parse(
          await NodeFSP.readFile(NodePath.join(this.directory, directory, "pet.json"), "utf8"),
        );
        this.petPath = await NodeFSP.realpath(NodePath.join(this.directory, directory));
        this.state = { ...this.state, customPet: String(manifest.name).slice(0, 60) };
      }
    } catch {
      /* The built-in pet remains available without an imported pack. */
    }
    this.start();
  }

  async configure(settings: DesktopPetSettings) {
    const next = decodeSettingsValue(settings);
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = NodePath.join(this.directory, "settings.json.tmp");
    await NodeFSP.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await NodeFSP.rename(temporary, NodePath.join(this.directory, "settings.json"));
    const changedExecutable = next.executable !== this.state.settings.executable;
    this.publish({ settings: next });
    if (changedExecutable || !this.child) {
      this.stop();
      this.start();
    } else this.sendConfiguration();
    return this.state;
  }

  async selectPet(petPath: string | null, name: string | null) {
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = NodePath.join(this.directory, "selected.json.tmp");
    await NodeFSP.writeFile(
      temporary,
      JSON.stringify(petPath === null ? null : NodePath.basename(petPath)),
      { mode: 0o600 },
    );
    await NodeFSP.rename(temporary, NodePath.join(this.directory, "selected.json"));
    const previous = this.petPath;
    this.petPath = petPath;
    this.publish({ customPet: name });
    this.sendConfiguration();
    if (
      previous &&
      previous !== petPath &&
      NodePath.dirname(previous) === (await NodeFSP.realpath(this.directory)) &&
      /^pack-[a-f0-9-]{36}$/.test(NodePath.basename(previous))
    )
      await NodeFSP.rm(previous, { recursive: true, force: true });
  }

  setShortcutRegistered(shortcutRegistered: boolean) {
    this.publish({ shortcutRegistered });
  }

  setProjection(projection: DesktopPetProjection) {
    if (projection.revision <= this.revision) return;
    this.revision = projection.revision;
    this.projection = { ...projection, revision: ++this.wireRevision };
    if (this.state.connection !== "ready") return;
    if (this.blocked) this.pendingProjection = this.projection;
    else this.write(this.projection);
  }

  resetProjection() {
    this.revision = -1;
    this.projection = {
      v: 1,
      type: "projection",
      revision: ++this.wireRevision,
      workingCount: 0,
      items: [],
    };
    this.pendingProjection = null;
    if (this.state.connection === "ready") this.write(this.projection);
  }

  toggle() {
    if (this.state.connection === "ready") this.write({ v: 1, type: "toggle" });
  }

  private write(message: unknown) {
    if (!this.child?.stdin.writable) return;
    this.blocked = !this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendConfiguration() {
    if (this.state.connection !== "ready") return;
    const { persistent, visible, reducedMotion } = this.state.settings;
    this.write({
      v: 1,
      type: "configure",
      persistent,
      visible,
      reducedMotion,
      petPath: this.petPath,
    });
  }

  private receive(event: DesktopPetNativeEvent) {
    if (event.type === "ready") {
      if (this.state.connection !== "starting") return this.fail("unexpected-ready");
      clearTimeout(this.handshake);
      this.publish({ connection: "ready", capabilities: event.capabilities, error: null });
      this.sendConfiguration();
      this.write(this.projection);
    } else if (this.state.connection !== "ready") {
      this.fail("event-before-ready");
    } else if (event.type === "state") {
      this.publish({ native: event });
    } else if (event.type === "action") {
      if (this.projection.items.some((item) => item.id === event.id)) this.emit(event);
    } else if (event.type === "error") {
      this.publish({ error: event.code });
    } else {
      this.fail(event.reason);
    }
  }

  private start() {
    if (NodeProcess.platform !== "linux") return;
    this.publish({ connection: "starting", native: null, capabilities: null, error: null });
    const child = NodeChildProcess.spawn(
      this.state.settings.executable || "weasel-desktop-pet",
      ["--stdio"],
      {
        env: nativeEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    this.child = child;
    const decode = createPetDecoder((event) => this.receive(event));
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      try {
        decode(chunk);
      } catch {
        this.fail("invalid-protocol");
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {
      if (this.child === child) this.fail("write-failed");
    });
    child.stdin.on("drain", () => {
      this.blocked = false;
      const pending = this.pendingProjection;
      this.pendingProjection = null;
      if (pending) this.write(pending);
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (this.child === child)
        this.fail(error.code === "ENOENT" ? "companion-not-found" : "start-failed");
    });
    child.once("exit", () => {
      if (this.child === child) this.fail("companion-exited");
    });
    this.handshake = setTimeout(() => this.fail("handshake-timeout"), 10_000);
    this.handshake.unref();
  }

  private fail(error: string) {
    this.stop();
    this.publish({
      connection: error === "companion-not-found" ? "unavailable" : "disconnected",
      error,
      native: null,
      capabilities: null,
    });
  }

  stop() {
    clearTimeout(this.handshake);
    const child = this.child;
    this.child = null;
    this.blocked = false;
    this.pendingProjection = null;
    if (child) {
      child.stdin.end(`${JSON.stringify({ v: 1, type: "shutdown" })}\n`);
      child.kill();
    }
  }
}

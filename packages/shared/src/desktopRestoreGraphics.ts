// @effect-diagnostics nodeBuiltinImport:off -- Verifies a desktop's private graphical launch context without importing Electron.
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  desktopRestoreDirectory,
  desktopRestoreProcessIdentity,
  writeDesktopRestoreJson,
} from "./desktopRestore.ts";

export const DesktopRestoreProcess = Schema.Struct({
  pid: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  processIdentity: Schema.String,
});
export type DesktopRestoreProcess = typeof DesktopRestoreProcess.Type;

const GraphicsEnvironment = Schema.Struct({
  DISPLAY: Schema.optionalKey(Schema.String),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.String),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.String),
  XDG_CONFIG_HOME: Schema.optionalKey(Schema.String),
  XAUTHORITY: Schema.optionalKey(Schema.String),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.String),
  NIXOS_OZONE_WL: Schema.optionalKey(Schema.String),
  ELECTRON_OZONE_PLATFORM_HINT: Schema.optionalKey(Schema.String),
  XDG_CURRENT_DESKTOP: Schema.optionalKey(Schema.String),
  KDE_SESSION_VERSION: Schema.optionalKey(Schema.String),
});
const Endpoint = Schema.Struct({
  path: Schema.String,
  device: Schema.Number,
  inode: Schema.Number,
  uid: Schema.Number,
  fileSizeBytes: Schema.NullOr(Schema.Number),
  fileModifiedMs: Schema.NullOr(Schema.Number),
  kind: Schema.Literals(["socket", "file", "directory"]),
});
const GraphicsContext = Schema.Struct({
  installationId: Schema.String,
  bootId: Schema.String,
  owner: DesktopRestoreProcess,
  environment: GraphicsEnvironment,
  passwordStore: Schema.NullOr(Schema.String),
  endpoints: Schema.Array(Endpoint),
});
const decodeContext = Schema.decodeUnknownSync(GraphicsContext);
const decodeEnvironment = Schema.decodeUnknownSync(GraphicsEnvironment);
const keys = Object.keys(GraphicsEnvironment.fields) as (keyof typeof GraphicsEnvironment.Type)[];

async function endpoint(
  path: string,
  kind: typeof Endpoint.Type.kind,
  allowRoot = false,
  privateDirectory = true,
) {
  if (!NodePath.isAbsolute(path)) throw new Error("Desktop graphics paths must be absolute.");
  const stat = await NodeFSP.lstat(path);
  const uid = process.getuid?.();
  if (
    uid === undefined ||
    (stat.uid !== uid && !(allowRoot && stat.uid === 0)) ||
    stat.isSymbolicLink() ||
    (kind === "socket"
      ? !stat.isSocket()
      : kind === "file"
        ? !stat.isFile()
        : !stat.isDirectory()) ||
    (kind !== "socket" &&
      (stat.mode & (kind === "directory" && !privateDirectory ? 0o022 : 0o077)) !== 0)
  )
    throw new Error("Desktop graphics context has unsafe ownership or permissions.");
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    uid: stat.uid,
    fileSizeBytes: kind === "file" ? stat.size : null,
    fileModifiedMs: kind === "file" ? stat.mtimeMs : null,
    kind,
  };
}

async function connect(path: string) {
  await new Promise<void>((resolve, reject) => {
    const socket = NodeNet.createConnection(path);
    socket.setTimeout(2_000, () =>
      socket.destroy(new Error("Desktop graphics socket is unavailable.")),
    );
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", () => reject(new Error("Desktop graphics socket is unavailable.")));
  });
}

async function inspectEnvironment(environment: typeof GraphicsEnvironment.Type) {
  const endpoints: (typeof Endpoint.Type)[] = [];
  if (environment.XDG_CONFIG_HOME === undefined)
    throw new Error("Desktop restore requires its original configuration directory.");
  endpoints.push(await endpoint(environment.XDG_CONFIG_HOME, "directory", false, false));
  if (environment.XDG_RUNTIME_DIR !== undefined)
    endpoints.push(await endpoint(environment.XDG_RUNTIME_DIR, "directory"));
  if (environment.WAYLAND_DISPLAY !== undefined) {
    if (environment.XDG_RUNTIME_DIR === undefined)
      throw new Error("Desktop Wayland context has no private runtime directory.");
    const socket = NodePath.resolve(environment.XDG_RUNTIME_DIR, environment.WAYLAND_DISPLAY);
    if (NodePath.dirname(socket) !== environment.XDG_RUNTIME_DIR)
      throw new Error("Desktop Wayland socket is outside its private runtime directory.");
    endpoints.push(await endpoint(socket, "socket"));
  }
  if (environment.DISPLAY !== undefined) {
    const display = /^:(\d+)(?:\.\d+)?$/.exec(environment.DISPLAY);
    if (display === null)
      throw new Error("Desktop restore requires a verified local graphical display.");
    endpoints.push(await endpoint(`/tmp/.X11-unix/X${display[1]}`, "socket", true));
  }
  if (environment.WAYLAND_DISPLAY === undefined && environment.DISPLAY === undefined)
    throw new Error("No verified desktop graphical launch context is available.");
  if (environment.XAUTHORITY !== undefined)
    endpoints.push(await endpoint(environment.XAUTHORITY, "file"));
  if (environment.DBUS_SESSION_BUS_ADDRESS !== undefined) {
    const address = /^unix:path=([^,;]+)(?:,guid=[0-9a-f]+)?$/.exec(
      environment.DBUS_SESSION_BUS_ADDRESS,
    );
    if (address === null) throw new Error("Desktop session bus context cannot be safely verified.");
    endpoints.push(await endpoint(address[1]!, "socket"));
  }
  for (const item of endpoints) if (item.kind === "socket") await connect(item.path);
  return endpoints;
}

export async function saveDesktopRestoreLaunchContext(input: {
  readonly baseDir: string;
  readonly installationId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly appDataDirectory?: string;
  readonly passwordStore?: string | null | undefined;
}) {
  const processIdentity = await desktopRestoreProcessIdentity(process.pid);
  if (processIdentity === null) throw new Error("Cannot prove the desktop process identity.");
  const environment = decodeEnvironment({
    ...Object.fromEntries(
      keys.flatMap((key) =>
        input.environment[key] === undefined ? [] : [[key, input.environment[key]]],
      ),
    ),
    ...(input.appDataDirectory === undefined ? {} : { XDG_CONFIG_HOME: input.appDataDirectory }),
  });
  const context = decodeContext({
    installationId: input.installationId,
    bootId: (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
    owner: { pid: process.pid, processIdentity },
    environment,
    passwordStore: input.passwordStore ?? null,
    endpoints: await inspectEnvironment(environment),
  });
  await writeDesktopRestoreJson(
    NodePath.join(desktopRestoreDirectory(input.baseDir), "graphics.json"),
    context,
  );
}

export async function readDesktopRestoreLaunchContext(baseDir: string, installationId: string) {
  const file = NodePath.join(desktopRestoreDirectory(baseDir), "graphics.json");
  try {
    await endpoint(file, "file");
    const stat = await NodeFSP.lstat(file);
    if (stat.size > 16 * 1024) throw new Error("Desktop graphical context exceeds its size bound.");
    const context = decodeContext(JSON.parse(await NodeFSP.readFile(file, "utf8")));
    if (
      context.installationId !== installationId ||
      context.bootId !==
        (await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() ||
      JSON.stringify(await inspectEnvironment(context.environment)) !==
        JSON.stringify(context.endpoints)
    )
      throw new Error(
        "Desktop graphical launch context is stale or belongs to another installation.",
      );
    return context;
  } catch {
    throw new Error(
      "No usable verified desktop graphical context. Start Crew in the graphical session first.",
    );
  }
}

export function desktopRestoreLaunchEnvironment(
  context: Awaited<ReturnType<typeof readDesktopRestoreLaunchContext>>,
) {
  const environment = { ...process.env };
  for (const key of keys) delete environment[key];
  return { ...environment, ...context.environment };
}

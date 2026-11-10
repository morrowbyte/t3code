// @effect-diagnostics nodeBuiltinImport:off -- Immutable Nix adapter shared by standalone restore controllers and the desktop.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Schema from "effect/Schema";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const StorePath = Schema.String.check(
  Schema.isPattern(/^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$/),
);
export const NixClosureMember = Schema.Struct({
  path: StorePath,
  narHash: Schema.String.check(Schema.isPattern(/^sha256[:-][A-Za-z0-9+/=]+$/)),
  narSize: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
});
export type NixClosureMember = typeof NixClosureMember.Type;
const NixProvenance = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  version: Schema.String,
  repository: Schema.Literal("morrowbyte/t3code"),
  channel: Schema.Literals(["stable", "nightly"]),
  system: Schema.Literal("x86_64-linux"),
  storePath: StorePath,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  compression: Schema.Literal("zstd"),
});
const decodeMember = Schema.decodeUnknownSync(NixClosureMember);
const decodeProvenance = Schema.decodeUnknownSync(NixProvenance);
const decodeStorePath = Schema.decodeUnknownSync(StorePath);

export async function readNixRestoreClosure(storePath: string, verify: boolean) {
  decodeStorePath(storePath);
  const { stdout } = await execFile(
    "nix",
    [
      "--extra-experimental-features",
      "nix-command",
      "path-info",
      "--recursive",
      "--json",
      storePath,
    ],
    { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  const value: unknown = JSON.parse(stdout);
  const members = Array.isArray(value)
    ? value.map((entry) => decodeMember(entry))
    : typeof value === "object" && value !== null
      ? Object.entries(value).map(([path, entry]) =>
          decodeMember(typeof entry === "object" && entry !== null ? { ...entry, path } : entry),
        )
      : [];
  members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    !members.some((member) => member.path === storePath) ||
    members.length > 10_000 ||
    new Set(members.map((member) => member.path)).size !== members.length
  )
    throw new Error("Nix closure membership is invalid.");
  if (verify) {
    for (const member of members)
      await execFile("nix-store", ["--verify-path", member.path], {
        timeout: 60_000,
        maxBuffer: 64 * 1024,
      });
  }
  return {
    members,
    sha256: NodeCrypto.createHash("sha256").update(JSON.stringify(members)).digest("hex"),
    sizeBytes: members.reduce((total, member) => total + member.narSize, 0),
  };
}

export async function readNixRestoreProvenance(dataDir: string, version: string) {
  if (!NodePath.isAbsolute(dataDir) || !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$/.test(version))
    throw new Error("Invalid Nix restore identity.");
  const file = NodePath.join(dataDir, "prepared", `${version}.json`);
  const stat = await NodeFSP.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
    throw new Error("Nix restore provenance is invalid.");
  const provenance = decodeProvenance(JSON.parse(await NodeFSP.readFile(file, "utf8")));
  if (
    provenance.version !== version ||
    (await NodeFSP.realpath(NodePath.join(dataDir, "versions", version))) !== provenance.storePath
  )
    throw new Error("Nix restore provenance changed.");
  return provenance;
}

export async function retainNixRestoreRoot(root: string, storePath: string) {
  decodeStorePath(storePath);
  await NodeFSP.mkdir(NodePath.dirname(root), { recursive: true, mode: 0o700 });
  try {
    if ((await NodeFSP.realpath(root)) !== storePath)
      throw new Error("Owned Nix restore root changed.");
    return;
  } catch (cause) {
    if (
      !(typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
    )
      throw cause;
  }
  await execFile(
    "nix-store",
    [
      "--add-root",
      root,
      "--indirect",
      "--realise",
      storePath,
      "--option",
      "max-jobs",
      "0",
      "--option",
      "builders",
      "",
      "--option",
      "substitute",
      "false",
    ],
    { timeout: 30_000, maxBuffer: 64 * 1024 },
  );
  if ((await NodeFSP.realpath(root)) !== storePath)
    throw new Error("Nix restore GC root was not registered.");
}

export async function switchNixRestore(input: {
  readonly updaterPath: string;
  readonly dataDir: string;
  readonly version: string;
  readonly expectedStorePath: string;
}) {
  if (!NodePath.isAbsolute(input.updaterPath))
    throw new Error("Nix restore requires an absolute updater.");
  const provenance = await readNixRestoreProvenance(input.dataDir, input.version);
  if (provenance.storePath !== input.expectedStorePath)
    throw new Error("Nix restore closure provenance changed before selection.");
  await readNixRestoreClosure(provenance.storePath, true);
  await execFile(input.updaterPath, ["--rollback", input.version], {
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024,
    env: { ...process.env, T3_MORROWBYTE_DATA_DIR: input.dataDir },
  });
  if ((await NodeFSP.realpath(NodePath.join(input.dataDir, "current"))) !== provenance.storePath)
    throw new Error("Nix rollback did not select the expected immutable closure.");
}

export function retainedDesktopBytes(
  artifacts: readonly {
    readonly sizeBytes: number;
    readonly nixClosure?: readonly NixClosureMember[];
  }[],
) {
  const members = new Map<string, number>();
  let files = 0;
  for (const artifact of artifacts) {
    if (artifact.nixClosure === undefined) files += artifact.sizeBytes;
    else for (const member of artifact.nixClosure) members.set(member.path, member.narSize);
  }
  return files + [...members.values()].reduce((total, size) => total + size, 0);
}

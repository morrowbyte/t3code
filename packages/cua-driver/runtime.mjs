import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";
import manifest from "./releases.json" with { type: "json" };

export const CUA_VERSION = manifest.version;
export const CUA_CONTRACT = manifest.contractVersion;
export const CUA_SOURCE = manifest.sourceCommit;
export const CUA_RELEASES = manifest.targets;
export function cuaRuntimeDependencies(dependencies) {
  const result = { ...dependencies };
  delete result["@trycua/cua-driver"];
  for (const key of Object.keys(result))
    if (key.startsWith("@trycua/cua-driver-")) delete result[key];
  return { ...result, "@ubjs/core": "0.31.0-3", "@ubjs/node": "0.31.0-3" };
}
export function cuaRelease(platform, arch) {
  return CUA_RELEASES[`${platform === "win" ? "win32" : platform}-${arch}`];
}
export function verifyCuaBytes(bytes, expected) {
  if (
    bytes.byteLength !== expected.bytes ||
    NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256
  )
    throw Error(`Cua integrity check failed: ${expected.name ?? "archive"}`);
}
const text = (bytes) => bytes.toString("utf8").replace(/\0.*$/su, "");
// The archive hash is checked first; only exact, hashed regular members are returned.
export function cuaArchiveMembers(bytes, release) {
  verifyCuaBytes(bytes, { bytes: release.archiveBytes, sha256: release.archiveSha256 });
  const wanted = new Map(
      [release.executable, release.library, release.addon].map((x) => [x.name, x]),
    ),
    result = new Map();
  function accept(name, content) {
    if (result.has(name)) throw Error(`Duplicate Cua member: ${name}`);
    verifyCuaBytes(content, wanted.get(name));
    result.set(name, content);
  }
  if (release.format === "tar.gz") {
    const tar = NodeZlib.gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 });
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((x) => x === 0)) break;
      const raw = text(header.subarray(124, 136)).trim();
      if (!/^[0-7]+$/u.test(raw)) throw Error("Invalid Cua tar size");
      const size = Number.parseInt(raw, 8),
        start = offset + 512;
      if (!Number.isSafeInteger(size) || start + size > tar.length)
        throw Error("Truncated Cua tar member");
      const prefix = text(header.subarray(345, 500));
      const name = `${prefix ? prefix + "/" : ""}${text(header.subarray(0, 100))}`.replace(
        /^\.\//u,
        "",
      );
      if (wanted.has(name)) {
        if (header[156] !== 0 && header[156] !== 48)
          throw Error("Cua member is not a regular file");
        accept(name, tar.subarray(start, start + size));
      }
      offset = start + Math.ceil(size / 512) * 512;
    }
  } else {
    let end = bytes.length - 22;
    const lower = Math.max(0, bytes.length - 65557);
    while (end >= lower && bytes.readUInt32LE(end) !== 0x06054b50) end--;
    if (end < lower) throw Error("Missing Cua zip directory");
    let cursor = bytes.readUInt32LE(end + 16);
    for (let count = bytes.readUInt16LE(end + 10); count > 0; count--) {
      if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
        throw Error("Invalid Cua zip directory");
      const names = bytes.readUInt16LE(cursor + 28),
        extra = bytes.readUInt16LE(cursor + 30),
        comment = bytes.readUInt16LE(cursor + 32);
      const name = bytes.toString("utf8", cursor + 46, cursor + 46 + names);
      if (wanted.has(name)) {
        if (bytes.readUInt16LE(cursor + 8) & 1) throw Error("Encrypted Cua zip member");
        const local = bytes.readUInt32LE(cursor + 42),
          size = bytes.readUInt32LE(cursor + 20);
        if (local + 30 > cursor || bytes.readUInt32LE(local) !== 0x04034b50)
          throw Error("Invalid Cua zip local header");
        const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
        if (start + size > cursor) throw Error("Invalid Cua zip member range");
        const method = bytes.readUInt16LE(cursor + 10),
          packed = bytes.subarray(start, start + size);
        if (method !== 0 && method !== 8) throw Error("Unsupported Cua zip compression");
        accept(
          name,
          method === 0
            ? packed
            : NodeZlib.inflateRawSync(packed, { maxOutputLength: wanted.get(name).bytes }),
        );
      }
      cursor += 46 + names + extra + comment;
    }
  }
  if (result.size !== wanted.size) throw Error("Cua archive is missing a pinned native member");
  return result;
}
export async function downloadCuaArchive(release, { archivePath, signal } = {}) {
  if (archivePath) return NodeFSP.readFile(archivePath);
  const response = await fetch(manifest.baseUrl + release.archive, {
    signal: signal ?? AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw Error(`Cua download failed: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > release.archiveBytes) throw Error("Cua archive exceeds pinned size");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function copyDependency(name, destination, from, seen = new Set()) {
  if (seen.has(name)) return;
  seen.add(name);
  const file = NodeModule.findPackageJSON(name, NodeURL.pathToFileURL(from).href);
  if (!file) throw Error(`Missing Cua dependency: ${name}`);
  const source = NodePath.dirname(file),
    pkg = JSON.parse(await NodeFSP.readFile(file, "utf8")),
    target = NodePath.join(destination, "node_modules", name);
  if ((name === "@ubjs/core" || name === "@ubjs/node") && pkg.version !== "0.31.0-3")
    throw Error(`Incompatible Cua dependency: ${name}`);
  await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
  await NodeFSP.cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (file) => !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
  for (const dependency of Object.keys(pkg.dependencies ?? {}))
    await copyDependency(dependency, destination, file, seen);
}
// Both CLI and desktop release builders use this physical, self-contained layout.
export async function stageCuaRuntime({
  destination,
  platform,
  arch,
  archivePath,
  sdkRoot = import.meta.dirname,
  signal,
}) {
  const release = cuaRelease(platform, arch);
  const members = release
    ? cuaArchiveMembers(await downloadCuaArchive(release, { archivePath, signal }), release)
    : undefined;
  const sdkTarget = NodePath.join(destination, "node_modules", "@trycua/cua-driver");
  const existing = await NodeFSP.lstat(sdkTarget).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (existing?.isSymbolicLink()) throw Error("Cua release stage points into a workspace");
  await NodeFSP.mkdir(sdkTarget, { recursive: true });
  for (const name of [
    "package.json",
    "upstream.json",
    "releases.json",
    "LICENSE.md",
    "THIRD_PARTY_NOTICES.md",
    "node-runtime-NOTICE.md",
    "runtime.mjs",
    "runtime.d.ts",
    "src",
    "dist",
  ])
    await NodeFSP.cp(NodePath.join(sdkRoot, name), NodePath.join(sdkTarget, name), {
      recursive: true,
      dereference: false,
    });
  for (const name of ["@ubjs/core", "@ubjs/node"])
    await copyDependency(name, destination, NodePath.join(sdkRoot, "package.json"));
  if (!release || !members) return undefined;
  const nativeRoot = NodePath.join(
    destination,
    "node_modules",
    `@trycua/cua-driver-${release.triple}`,
  );
  await NodeFSP.mkdir(nativeRoot, { recursive: true });
  for (const [name, content] of members)
    await NodeFSP.writeFile(NodePath.join(nativeRoot, name), content, {
      mode: name === release.executable.name ? 0o755 : 0o644,
    });
  await NodeFSP.writeFile(
    NodePath.join(nativeRoot, "package.json"),
    JSON.stringify({
      name: `@trycua/cua-driver-${release.triple}`,
      version: CUA_VERSION,
      license: "MIT AND MPL-2.0",
    }) + "\n",
  );
  await NodeFSP.copyFile(
    NodePath.join(sdkRoot, "node-runtime-NOTICE.md"),
    NodePath.join(nativeRoot, "node-runtime-NOTICE.md"),
  );
  return {
    release,
    executable: NodePath.join(nativeRoot, release.executable.name),
    sdkRoot: sdkTarget,
  };
}

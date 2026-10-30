#!/usr/bin/env node
// Share the installer's runtime cache; pre-0.0.41 services re-enter here over IPC.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { version } = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"),
);

const SUPPORTED = ["darwin-arm64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];

function t3Home() {
  const raw = (process.env.T3CODE_HOME || "").trim();
  if (raw === "") return path.join(os.homedir(), ".t3");
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return path.join(os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

async function get(url) {
  const response = await fetch(url);
  if (response.status === 404) {
    throw new Error(
      `${url} does not exist yet. If ${version} was just released, try again in a few minutes.`,
    );
  }
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`);
  return response;
}

async function download(url, file) {
  const response = await get(url);
  const total = Number(response.headers.get("content-length")) || 0;
  const hash = crypto.createHash("sha256");
  const out = fs.openSync(file, "w");
  const tty = process.stderr.isTTY;
  let received = 0;
  let shown = -1;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      fs.writeSync(out, chunk);
      received += chunk.byteLength;
      // Redraw once per percent (or per MB without a length), not per chunk.
      const step = total ? Math.floor((received * 100) / total) : Math.floor(received / 1048576);
      if (tty && step !== shown) {
        shown = step;
        const percent = total ? ` ${step}%` : "";
        process.stderr.write(
          `\r\x1b[2Kt3: downloading T3 Code ${version}${percent} (${(received / 1048576).toFixed(1)} MB)`,
        );
      }
    }
  } finally {
    fs.closeSync(out);
    if (tty) process.stderr.write("\r\x1b[2K");
  }
  return hash.digest("hex");
}

function parseChecksums(text) {
  const entries = new Map();
  for (const line of text.trimEnd().split(/\r?\n/)) {
    const match = /^([0-9a-f]{64})[ \t]+\*?([A-Za-z0-9][A-Za-z0-9._+-]*)$/i.exec(line);
    if (!match) throw new Error("Invalid release checksum entry");
    if (entries.has(match[2])) throw new Error("Duplicate release checksum entry");
    entries.set(match[2], match[1].toLowerCase());
  }
  return entries;
}

function receiptField(text, name) {
  const values = text.split(/\r?\n/).filter((line) => line.startsWith(`${name}=`));
  if (values.length !== 1) throw new Error(`Missing or duplicate receipt ${name}`);
  return values[0].slice(name.length + 1);
}

function verifyReceipt(text, sums, manifest, source) {
  if (receiptField(text, "fork_release") !== `v${version}`) {
    throw new Error("Release receipt fork_release mismatch");
  }
  if (receiptField(text, "source_sha") !== source) {
    throw new Error("Release receipt source_sha mismatch");
  }
  const blocks = text.split("artifact_sha256:\n");
  if (blocks.length !== 2 || blocks[1] !== sums) {
    throw new Error("Release receipt checksum block mismatch");
  }
  const entries = parseChecksums(sums);
  entries.set(manifest, crypto.createHash("sha256").update(sums).digest("hex"));
  const digests = JSON.parse(receiptField(text, "github_asset_digests"));
  if (!Array.isArray(digests) || digests.length !== entries.size) {
    throw new Error("Invalid receipt GitHub digests");
  }
  for (const entry of digests) {
    if (
      !entry ||
      !entries.has(entry.name) ||
      entry.digest !== `sha256:${entries.get(entry.name)}`
    ) {
      throw new Error("Release receipt GitHub digest mismatch");
    }
    entries.delete(entry.name);
  }
}

async function checksumForArchive(releaseUrl, archive, key) {
  const sums = await (await get(`${releaseUrl}/SHA256SUMS`)).text();
  const entries = parseChecksums(sums);
  if (entries.has(archive)) return entries.get(archive);
  if (!key.startsWith("win32-")) {
    throw new Error(`${archive} is not listed in the release's SHA256SUMS`);
  }
  const original = await (await get(`${releaseUrl}/RELEASE-RECEIPT.txt`)).text();
  const source = receiptField(original, "source_sha");
  if (!/^[a-f0-9]{40}$/.test(source)) throw new Error("Invalid receipt source_sha");
  verifyReceipt(original, sums, "SHA256SUMS", source);
  const windowsSums = await (await get(`${releaseUrl}/SHA256SUMS-windows`)).text();
  const windowsReceipt = await (await get(`${releaseUrl}/RELEASE-RECEIPT-windows.txt`)).text();
  verifyReceipt(windowsReceipt, windowsSums, "SHA256SUMS-windows", source);
  const expected = parseChecksums(windowsSums).get(archive);
  if (!expected) throw new Error(`${archive} is not listed in SHA256SUMS-windows`);
  return expected;
}

async function install(dir, key) {
  const archive = `t3-${version}-${key}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
  const base = (
    process.env.T3CODE_RELEASE_BASE_URL || "https://github.com/pingdotgg/t3code/releases/download"
  ).replace(/\/+$/, "");
  const releaseUrl = `${base}/v${version}`;
  const expected = await checksumForArchive(releaseUrl, archive, key);

  // Stage beside the destination and rename atomically to avoid half-installed versions.
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(`${dir}.staging-`);
  try {
    const file = path.join(staging, archive);
    if ((await download(`${releaseUrl}/${archive}`, file)) !== expected) {
      throw new Error(`checksum mismatch for ${archive}`);
    }
    // Windows' own tar.exe reads zip; a Git-for-Windows tar on PATH cannot.
    const tar =
      process.platform === "win32" ? `${process.env.SystemRoot}\\System32\\tar.exe` : "tar";
    const extract = spawnSync(tar, ["-xf", file, "-C", staging, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (extract.status !== 0) throw new Error(`could not extract ${archive}`);
    fs.rmSync(file);
    fs.writeFileSync(path.join(staging, ".install-complete"), `${version}\n`);
    publish(staging, dir);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

const isComplete = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".install-complete"), "utf8").trim() === version;
  } catch {
    return false;
  }
};

/** Preserve concurrently published complete installs; replace only incomplete folders without the completion marker. */
function publish(staging, dir) {
  try {
    fs.renameSync(staging, dir);
    return;
  } catch (error) {
    if (isComplete(dir)) return;
    if (!fs.existsSync(dir)) throw error;
  }
  const lock = `${dir}.lock`;
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      `another t3 is installing ${version}. If none is running, delete ${lock} and try again.`,
      { cause: error },
    );
  }
  const stale = `${staging}.stale`;
  try {
    // A peer may have published between our marker check and taking the lock.
    if (isComplete(dir)) return;
    // Move it aside rather than deleting in place: once the folder is empty, a
    // peer's first rename can land in it.
    fs.renameSync(dir, stale);
    try {
      fs.renameSync(staging, dir);
    } catch (error) {
      if (!isComplete(dir)) throw error;
    }
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    fs.rmSync(stale, { recursive: true, force: true });
  }
}

async function main() {
  const key = `${process.platform}-${process.arch}`;
  if (!SUPPORTED.includes(key)) {
    throw new Error(
      `no T3 Code CLI build is available for ${key} (supported: ${SUPPORTED.join(", ")}).\n` +
        "The desktop app is at https://github.com/pingdotgg/t3code/releases",
    );
  }
  const dir = path.join(t3Home(), "runtime", "versions", version);
  if (!isComplete(dir)) await install(dir, key);

  // Service IPC and signals must reach the child; terminal Ctrl-C already does, so do not forward SIGINT twice.
  const ipc = process.send !== undefined;
  const child = spawn(
    path.join(dir, process.platform === "win32" ? "t3.exe" : "t3"),
    process.argv.slice(2),
    {
      stdio: ipc ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
      // The executable lives in the T3 home, so this is how it knows npm launched it.
      env: { ...process.env, T3CODE_NPM_LAUNCHER_PATH: import.meta.filename },
    },
  );
  if (ipc) {
    process.on("message", (message) => child.connected && child.send(message));
    child.on("message", (message) => process.connected && process.send(message));
    process.on("disconnect", () => child.connected && child.disconnect());
  }
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => (ipc || signal !== "SIGINT") && child.kill(signal));
  }
  child.on("error", (error) => fail(error));
  child.on("exit", (code, signal) =>
    process.exit(code ?? 128 + (os.constants.signals[signal] || 1)),
  );
}

function fail(error) {
  process.stderr.write(`t3: ${error.message}\n`);
  process.exit(1);
}

await main().catch(fail);

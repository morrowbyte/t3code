"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const yaml = createRequire(path.resolve(__dirname, "../../packages/shared/package.json"))("yaml");
const hash = (bytes, algorithm = "sha256") =>
  createHash(algorithm)
    .update(bytes)
    .digest(algorithm === "sha512" ? "base64" : "hex");
const safeName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name);

function config(env) {
  assert.equal(env.GH_REPO, "morrowbyte/t3code", "GH_REPO must be morrowbyte/t3code");
  assert(
    /^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(env.RELEASE_VERSION),
    "Invalid nightly version",
  );
  assert.equal(env.RELEASE_TAG, `v${env.RELEASE_VERSION}`);
  assert(/^[a-f0-9]{40}$/.test(env.SOURCE_SHA), "Invalid source SHA");
  assert(/^\d+$/.test(env.GITHUB_RUN_ID), "Missing run ID");
  assert(/^\d+$/.test(env.GITHUB_RUN_ATTEMPT), "Missing run attempt");
  return {
    repo: env.GH_REPO,
    tag: env.RELEASE_TAG,
    version: env.RELEASE_VERSION,
    source: env.SOURCE_SHA,
    run: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}

function windowsNames(version) {
  return [
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.exe.blockmap`,
    `t3-${version}-win32-x64.zip`,
    "nightly.yml",
  ];
}

function checksums(bytes) {
  const result = new Map();
  for (const line of bytes.toString().trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(match && safeName(match[2]), "Invalid checksum name or SHA");
    assert(!result.has(match[2]), "Duplicate checksum name");
    result.set(match[2], match[1]);
  }
  return result;
}

function receipt(bytes, cfg, sums) {
  const text = bytes.toString();
  const field = (key) => {
    const values = text.split("\n").filter((line) => line.startsWith(`${key}=`));
    assert.equal(values.length, 1, `Missing or duplicate ${key}`);
    return values[0].slice(key.length + 1);
  };
  assert.equal(field("fork_release"), cfg.tag);
  assert.equal(field("source_sha"), cfg.source);
  assert.equal(text.split("artifact_sha256:\n").length, 2);
  assert.equal(
    text.split("artifact_sha256:\n")[1],
    sums.toString(),
    "Receipt checksum block differs",
  );
  const digests = JSON.parse(field("github_asset_digests"));
  assert(Array.isArray(digests));
  assert.equal(new Set(digests.map((entry) => entry.name)).size, digests.length);
  return digests;
}

function verifyAssets(release, files, cfg) {
  assert.equal(release.tag_name, cfg.tag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, true);
  assert.equal(release.target_commitish, cfg.source, "Release target must be the exact source SHA");
  assert.equal(new Set(release.assets.map((asset) => asset.name)).size, release.assets.length);
  assert.deepEqual([...files.keys()].sort(), release.assets.map((asset) => asset.name).sort());
  for (const asset of release.assets) {
    assert(safeName(asset.name), "Unsafe release asset name");
    const bytes = files.get(asset.name);
    assert.equal(asset.digest, `sha256:${hash(bytes)}`, `GitHub digest differs: ${asset.name}`);
    assert.equal(asset.size, bytes.length, `GitHub size differs: ${asset.name}`);
  }
}

function verifyOriginal(release, files, cfg) {
  verifyAssets(release, files, cfg);
  const sums = files.get("SHA256SUMS");
  assert(sums, "Missing original checksums");
  const entries = checksums(sums);
  const originalReceipt = files.get("RELEASE-RECEIPT.txt");
  const digests = receipt(originalReceipt, cfg, sums);
  const receiptLines = originalReceipt.toString().split("\n");
  assert.deepEqual(
    receiptLines.filter((line) => line.startsWith("release_platforms=")),
    ["release_platforms=linux-x64,nixos-x64,android-arm64"],
  );
  assert.deepEqual(
    receiptLines.filter((line) => line.startsWith("windows_status=")),
    ["windows_status=pending"],
  );
  const original = new Set([...entries.keys(), "SHA256SUMS", "RELEASE-RECEIPT.txt"]);
  const required = [
    "nightly-linux.yml",
    "morrowbyte-linux-x64.tar.gz",
    `T3-Code-${cfg.version}-x86_64.AppImage`,
    `T3-Code-${cfg.version}-x86_64-linux-nix-closure.nar.zst`,
    `T3-Code-${cfg.version}-x86_64-linux-nix-closure.json`,
    "install-linux.sh",
    `t3-${cfg.version}-linux-x64.tar.gz`,
  ];
  const apk = `Morrowbyte-${cfg.version}-android-arm64.apk`;
  required.push(apk, `${apk}.json`, `${apk}.sha256`);
  for (const name of required) assert(entries.has(name), `Missing original asset: ${name}`);
  for (const [name, digest] of entries)
    assert.equal(hash(files.get(name)), digest, `Original checksum differs: ${name}`);
  assert.deepEqual(
    digests.map((entry) => entry.name).sort(),
    [...original].filter((name) => name !== "RELEASE-RECEIPT.txt").sort(),
  );
  for (const entry of digests) assert.equal(entry.digest, `sha256:${hash(files.get(entry.name))}`);
  const proof = JSON.parse(files.get(`${apk}.json`));
  assert.equal(proof.apk, apk);
  assert.equal(proof.apkSha256, hash(files.get(apk)));
  assert.equal(proof.source, cfg.source);
  assert.equal(proof.version, cfg.version);
  assert.equal(proof.package, "com.morrowbyte.t3code");
  assert.deepEqual(proof.abis, ["arm64-v8a"]);
  assert(
    Number.isInteger(proof.versionCode) && proof.versionCode > 0 && proof.versionCode <= 2100000000,
  );
  assert.equal(
    proof.certificateSha256,
    "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2",
  );
  for (const key of ["signatureVerified", "zip16KB", "elf16KB"]) assert.equal(proof[key], true);
  assert.equal(files.get(`${apk}.sha256`).toString(), `${hash(files.get(apk))}  ${apk}\n`);
  const allowed = new Set([
    ...windowsNames(cfg.version),
    "SHA256SUMS-windows",
    "RELEASE-RECEIPT-windows.txt",
  ]);
  for (const name of original)
    assert(!allowed.has(name), `Windows asset in original receipt: ${name}`);
  for (const name of files.keys())
    assert(original.has(name) || allowed.has(name), `Unexpected appended asset: ${name}`);
  return original;
}

function validateWindows(files, cfg) {
  const names = windowsNames(cfg.version);
  assert.deepEqual([...files.keys()].sort(), [...names].sort(), "Unexpected Windows payload names");
  for (const name of names) assert(files.get(name).length > 0, `Empty asset: ${name}`);
  const feed = yaml.parse(files.get("nightly.yml").toString());
  assert.equal(feed.version, cfg.version);
  assert.equal(feed.path, names[0]);
  assert.equal(feed.sha512, hash(files.get(names[0]), "sha512"));
  assert(Array.isArray(feed.files) && feed.files.length === 1);
  assert.equal(feed.files[0].url, names[0]);
  assert.equal(feed.files[0].sha512, feed.sha512);
  assert.equal(feed.files[0].size, files.get(names[0]).length);
}

function validateCliArchive(names, executable, cfg) {
  const root = `t3-${cfg.version}-win32-x64/`;
  assert.equal(new Set(names).size, names.length, "Duplicate CLI archive entry");
  assert(
    names.every(
      (name) =>
        name.startsWith(root) &&
        !name.includes("\\") &&
        !name.split("/").some((part) => part === "." || part === ".."),
    ),
    "CLI archive version or path differs",
  );
  assert(names.includes(`${root}t3.exe`), "CLI executable missing");
  assert(executable.subarray(0, 2).equals(Buffer.from("MZ")), "CLI is not a Windows executable");
  const versions = [
    ...new Set(executable.toString("latin1").match(/\d+\.\d+\.\d+-nightly\.\d{8}\.\d+/g)),
  ];
  assert.deepEqual(versions, [cfg.version], "Embedded CLI version differs");
}

function assertCompatibleAppend(existing, additions) {
  for (const [name, bytes] of additions) {
    if (existing.has(name))
      assert(existing.get(name).equals(bytes), `Existing Windows asset differs: ${name}`);
  }
}

function run(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(result.status, 0, `${file} failed: ${result.stderr}`);
  return result.stdout;
}

function publish(directory, env = process.env) {
  const cfg = config(env);
  directory = path.resolve(directory);
  const windows = new Map(
    fs.readdirSync(directory).map((name) => {
      assert(
        safeName(name) && fs.lstatSync(path.join(directory, name)).isFile(),
        "Invalid payload file",
      );
      return [name, fs.readFileSync(path.join(directory, name))];
    }),
  );
  const archive = path.join(directory, `t3-${cfg.version}-win32-x64.zip`);
  const archiveNames = run("unzip", ["-Z1", archive]).trim().split("\n");
  const executableName = `t3-${cfg.version}-win32-x64/t3.exe`;
  const binary = spawnSync("unzip", ["-p", archive, executableName], {
    maxBuffer: 512 * 1024 * 1024,
  });
  assert.equal(binary.status, 0, "Cannot read archived CLI executable");
  validateCliArchive(archiveNames, binary.stdout, cfg);
  validateWindows(windows, cfg);
  const gh = (...args) => run("gh", args);
  const metadata = () => JSON.parse(gh("api", `repos/${cfg.repo}/releases/tags/${cfg.tag}`));
  const verifyTag = () => {
    const tag = JSON.parse(gh("api", `repos/${cfg.repo}/git/ref/tags/${cfg.tag}`));
    let object = tag.object;
    for (let depth = 0; object.type === "tag" && depth < 8; depth++)
      object = JSON.parse(gh("api", `repos/${cfg.repo}/git/tags/${object.sha}`)).object;
    assert.equal(object.type, "commit");
    assert.equal(object.sha, cfg.source, "Tag source differs");
  };
  verifyTag();
  const tempRoot =
    env.RUNNER_TEMP || path.join(os.homedir(), ".cache/agent-tasks/boat-ci-release-20261030");
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, "append-windows-"));
  try {
    const download = (label) => {
      const release = metadata();
      for (const asset of release.assets) assert(safeName(asset.name), "Unsafe release asset name");
      const dest = path.join(temp, label);
      fs.mkdirSync(dest);
      console.log(
        `Downloading ${label}: ${release.assets.length} assets, ${release.assets.reduce((sum, asset) => sum + asset.size, 0)} bytes.`,
      );
      gh("release", "download", cfg.tag, "--repo", cfg.repo, "--dir", dest);
      console.log(`Downloaded ${label}; verifying all asset bytes and receipts.`);
      const files = new Map(
        fs.readdirSync(dest).map((name) => [name, fs.readFileSync(path.join(dest, name))]),
      );
      verifyOriginal(release, files, cfg);
      console.log(`Verified ${label}: ${files.size} assets.`);
      return files;
    };
    const before = download("before");
    const sums = Buffer.from(
      [...windows]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => `${hash(bytes)}  ${name}\n`)
        .join(""),
    );
    windows.set("SHA256SUMS-windows", sums);
    const digests = [...windows]
      .map(([name, bytes]) => ({ name, digest: `sha256:${hash(bytes)}` }))
      .sort((a, b) => a.name.localeCompare(b.name));
    let receiptBytes = Buffer.from(
      `fork_release=${cfg.tag}\nsource_sha=${cfg.source}\nrelease_platforms=windows-x64\npublication_run_id=${cfg.run}\npublication_run_attempt=${cfg.attempt}\n` +
        (env.GITHUB_WORKFLOW_SHA
          ? `publication_workflow_sha=${env.GITHUB_WORKFLOW_SHA}\npublication_workflow_ref=${env.GITHUB_WORKFLOW_REF}\n`
          : "") +
        (env.SOURCE_RUN_ID ? `retained_bundle_origin_run_id=${env.SOURCE_RUN_ID}\n` : "") +
        (env.WINDOWS_BUILD_RUN_ID
          ? `windows_build_run_id=${env.WINDOWS_BUILD_RUN_ID}\nwindows_build_workflow_sha=${env.WINDOWS_BUILD_WORKFLOW_SHA}\n`
          : "") +
        `github_asset_digests=${JSON.stringify(digests)}\nartifact_sha256:\n${sums}`,
    );
    if (before.has("RELEASE-RECEIPT-windows.txt")) {
      receiptBytes = before.get("RELEASE-RECEIPT-windows.txt");
      assert.deepEqual(
        receipt(receiptBytes, cfg, sums).sort((a, b) => a.name.localeCompare(b.name)),
        digests,
      );
    }
    windows.set("RELEASE-RECEIPT-windows.txt", receiptBytes);
    assertCompatibleAppend(before, windows);
    for (const [name, bytes] of windows) {
      if (before.has(name)) continue;
      const file = path.join(temp, name);
      fs.writeFileSync(file, bytes);
      console.log(`Appending ${name}: ${bytes.length} bytes.`);
      gh("release", "upload", cfg.tag, file, "--repo", cfg.repo);
    }
    const after = download("after");
    assert.deepEqual(
      [...after.keys()].sort(),
      [...new Set([...before.keys(), ...windows.keys()])].sort(),
    );
    for (const [name, bytes] of [...before, ...windows])
      assert(after.get(name).equals(bytes), `Final bytes differ: ${name}`);
    verifyTag();
    console.log(
      `Verified Windows append to ${cfg.tag}; all ${before.size} existing assets preserved.`,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

module.exports = {
  config,
  hash,
  checksums,
  receipt,
  verifyAssets,
  verifyOriginal,
  validateWindows,
  validateCliArchive,
  assertCompatibleAppend,
  windowsNames,
  publish,
};
if (require.main === module) {
  assert.equal(process.argv[2], "publish");
  assert.equal(
    process.argv.length,
    4,
    "Usage: append-windows-release.cjs publish <windows-assets-dir>",
  );
  publish(process.argv[3]);
}

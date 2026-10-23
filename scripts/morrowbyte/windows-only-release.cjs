"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const yaml = createRequire(resolve(__dirname, "../../packages/shared/package.json"))("yaml");

const repository = "morrowbyte/t3code";
const runtimeSource = "9ce2d4a0bb8f228097f8f8fca4d083ecc3eec13d";
const runtimeTag = "v0.1.2-nightly.20261020.61";
const runtimeName = "t3-0.1.2-nightly.20261020.61-linux-x64.tar.gz";
const runtimeDigest = "a469af45aaf05af7ad1103b327e83a1824984c2ed5a5534d8c2e32a4b5440d6d";
const feedDigest = "69dad0d73559fbebcf4c6e369a94f5d494055bca00d8dd2cfb1560a54566006a";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const exec = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};
const gh = (...args) => exec("gh", args);
const git = (...args) => exec("git", args).trim();
const api = (path) => JSON.parse(gh("api", `repos/${repository}/${path}`));

function assertRuntimeSourceUnchanged(paths) {
  for (const path of paths) {
    assert(
      path.startsWith("apps/desktop/") ||
        [
          ".github/workflows/morrowbyte-release.yml",
          "scripts/build-desktop-artifact.ts",
          "scripts/windows-wsl-runtime.test.ts",
          "scripts/morrowbyte/check.sh",
          "scripts/morrowbyte/windows-only-release.cjs",
          "scripts/morrowbyte/nightly-after-ci.test.cjs",
        ].includes(path),
      `Published WSL runtime cannot be reused after a server/dependency change: ${path}`,
    );
  }
}

function validateOrigin(release) {
  assert.equal(release.tag_name, runtimeTag);
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, true);
  for (const [name, digest] of [
    [runtimeName, runtimeDigest],
    ["nightly-linux.yml", feedDigest],
  ]) {
    const assets = release.assets.filter((asset) => asset.name === name);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].digest, `sha256:${digest}`);
  }
}

function downloadOriginal(name, directory, digest) {
  mkdirSync(directory, { recursive: true });
  gh(
    "release",
    "download",
    runtimeTag,
    "--repo",
    repository,
    "--pattern",
    name,
    "--dir",
    directory,
  );
  const file = resolve(directory, name);
  assert.equal(hash(readFileSync(file)), digest);
  return file;
}

function preserveLinuxFeed(original) {
  assert.equal(hash(original), feedDigest);
  const feed = yaml.parse(original.toString());
  assert.equal(feed.version, runtimeTag.slice(1));
  const url = (value) => {
    assert.equal(typeof value, "string");
    assert(!value.includes("/") && !value.includes("\\") && value !== "..");
    return `https://github.com/${repository}/releases/download/${runtimeTag}/${encodeURIComponent(value)}`;
  };
  feed.path = url(feed.path);
  assert(Array.isArray(feed.files) && feed.files.length > 0);
  for (const file of feed.files) file.url = url(file.url);
  return yaml.stringify(feed);
}

function validatePayload(directory, version) {
  assert(/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(version));
  const names = readdirSync(directory).sort();
  const required = [
    `T3-Code-${version}-x64.exe`,
    `T3-Code-${version}-x64.exe.blockmap`,
    `t3-${version}-win32-x64.zip`,
    "nightly.yml",
    "nightly-linux.yml",
    "WINDOWS-ONLY.json",
  ];
  assert(required.every((name) => names.includes(name)));
  const allowed = new Set([...required, "builder-debug.yml", "SHA256SUMS", "RELEASE-RECEIPT.txt"]);
  assert(
    names.every((name) => allowed.has(name)),
    "Windows-only publication contains another platform package or unexpected file",
  );
  const windowsFeed = yaml.parse(readFileSync(resolve(directory, "nightly.yml"), "utf8"));
  assert.equal(windowsFeed.version, version);
  const linuxFeed = yaml.parse(readFileSync(resolve(directory, "nightly-linux.yml"), "utf8"));
  assert.equal(linuxFeed.version, runtimeTag.slice(1));
  assert(
    linuxFeed.files.every((file) =>
      file.url.startsWith(`https://github.com/${repository}/releases/download/${runtimeTag}/`),
    ),
  );
  return names;
}

function main(mode, directory) {
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  git("merge-base", "--is-ancestor", runtimeSource, "HEAD");
  assertRuntimeSourceUnchanged(
    git("diff", "--name-only", runtimeSource, "HEAD").split("\n").filter(Boolean),
  );
  validateOrigin(api(`releases/tags/${runtimeTag}`));
  if (mode === "runtime") {
    downloadOriginal(runtimeName, directory, runtimeDigest);
    return;
  }
  assert.equal(mode, "publish");
  const source = process.env.SOURCE_SHA,
    version = process.env.RELEASE_VERSION;
  assert.equal(git("rev-parse", "HEAD"), source);
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  const tag = `v${version}`,
    title = `Morrowbyte Windows Nightly ${version}`;
  const originalFeed = downloadOriginal("nightly-linux.yml", directory, feedDigest);
  writeFileSync(originalFeed, preserveLinuxFeed(readFileSync(originalFeed)));
  const provenance = {
    platforms: ["win32-x64"],
    source,
    version,
    wslRuntime: {
      source: runtimeSource,
      release: runtimeTag,
      asset: runtimeName,
      sha256: runtimeDigest,
    },
    linuxFeed: { version: runtimeTag.slice(1), originalSha256: feedDigest },
    nixosDiscovery: "Windows release title excluded by existing Morrowbyte Nightly filter",
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  writeFileSync(
    resolve(directory, "WINDOWS-ONLY.json"),
    JSON.stringify(provenance, null, 2) + "\n",
  );
  const names = validatePayload(directory, version);
  writeFileSync(
    resolve(directory, "SHA256SUMS"),
    names
      .filter((name) => !["SHA256SUMS", "RELEASE-RECEIPT.txt"].includes(name))
      .map((name) => `${hash(readFileSync(resolve(directory, name)))}  ${name}\n`)
      .join(""),
  );
  writeFileSync(
    resolve(directory, "RELEASE-RECEIPT.txt"),
    `fork_release=${tag}\nsource_sha=${source}\nrelease_platforms=windows-x64\npublication_run_id=${process.env.GITHUB_RUN_ID}\nwsl_runtime_source=${runtimeSource}\nwsl_runtime_sha256=${runtimeDigest}\n`,
  );
  const existing = spawnSync(
    "gh",
    ["release", "view", tag, "--repo", repository, "--json", "isDraft,targetCommitish"],
    { encoding: "utf8" },
  );
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout);
    assert.equal(release.isDraft, true, "Refusing to replace published release assets");
    assert.equal(release.targetCommitish, source);
  } else {
    assert.equal(existing.status, 1);
    gh(
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--target",
      source,
      "--title",
      title,
      "--prerelease",
      "--draft",
      "--latest=false",
      "--notes",
      `Windows-only Morrowbyte release. Application source ${source}. WSL backend reuses the unchanged published ${runtimeTag} runtime (${runtimeSource}). No Linux, NixOS, Android or macOS packages were built. Linux updater metadata continues to reference .61; NixOS and Android stay on their existing releases.`,
    );
  }
  const files = readdirSync(directory).sort();
  for (const name of files) {
    assert.equal(api(`releases/tags/${tag}`).draft, true);
    gh("release", "upload", tag, resolve(directory, name), "--repo", repository, "--clobber");
  }
  const check = () => {
    const release = api(`releases/tags/${tag}`);
    assert.equal(release.tag_name, tag);
    assert.equal(release.target_commitish, source);
    assert.equal(release.name, title);
    assert.equal(release.prerelease, true);
    assert.deepEqual(release.assets.map((asset) => asset.name).sort(), files);
    for (const asset of release.assets) {
      const bytes = readFileSync(resolve(directory, asset.name));
      assert.equal(asset.size, bytes.length);
      assert.equal(asset.digest, `sha256:${hash(bytes)}`);
    }
    return release;
  };
  assert.equal(check().draft, true);
  gh("release", "edit", tag, "--repo", repository, "--draft=false", "--latest=false");
  assert.equal(check().draft, false);
  console.log(`Published verified Windows-only release ${tag}`);
}

module.exports = {
  assertRuntimeSourceUnchanged,
  preserveLinuxFeed,
  validateOrigin,
  validatePayload,
  runtimeTag,
};
if (require.main === module) main(process.argv[2], process.argv[3]);

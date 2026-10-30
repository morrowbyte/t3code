"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  config,
  hash,
  checksums,
  receipt,
  verifyOriginal,
  validateWindows,
  validateCliArchive,
  assertCompatibleAppend,
  windowsNames,
} = require("./append-windows-release.cjs");
const env = {
  GH_REPO: "morrowbyte/t3code",
  RELEASE_VERSION: "0.1.4-nightly.20261030.1",
  RELEASE_TAG: "v0.1.4-nightly.20261030.1",
  SOURCE_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "42",
  GITHUB_RUN_ATTEMPT: "1",
};
const cfg = config(env);
function fixture() {
  const apk = `Morrowbyte-${cfg.version}-android-arm64.apk`;
  const names = [
    "nightly-linux.yml",
    "morrowbyte-linux-x64.tar.gz",
    `T3-Code-${cfg.version}-x86_64.AppImage`,
    `T3-Code-${cfg.version}-x86_64-linux-nix-closure.nar.zst`,
    `T3-Code-${cfg.version}-x86_64-linux-nix-closure.json`,
    "install-linux.sh",
    `t3-${cfg.version}-linux-x64.tar.gz`,
    apk,
  ];
  const files = new Map(names.map((name) => [name, Buffer.from(name)]));
  files.set(`${apk}.sha256`, Buffer.from(`${hash(files.get(apk))}  ${apk}\n`));
  files.set(
    `${apk}.json`,
    Buffer.from(
      JSON.stringify({
        apk,
        apkSha256: hash(files.get(apk)),
        source: cfg.source,
        version: cfg.version,
        package: "com.morrowbyte.t3code",
        abis: ["arm64-v8a"],
        versionCode: 1,
        certificateSha256: "34a33c2541544bc4a96e359a33e9f71aaa449ee9a0cd725c2469b65b057aa2b2",
        signatureVerified: true,
        zip16KB: true,
        elf16KB: true,
      }),
    ),
  );
  const sums = Buffer.from([...files].map(([name, bytes]) => `${hash(bytes)}  ${name}\n`).join(""));
  files.set("SHA256SUMS", sums);
  const digests = [...files].map(([name, bytes]) => ({ name, digest: `sha256:${hash(bytes)}` }));
  files.set(
    "RELEASE-RECEIPT.txt",
    Buffer.from(
      `fork_release=${cfg.tag}\nsource_sha=${cfg.source}\nrelease_platforms=linux-x64,nixos-x64,android-arm64\nwindows_status=pending\ngithub_asset_digests=${JSON.stringify(digests)}\nartifact_sha256:\n${sums}`,
    ),
  );
  const release = {
    tag_name: cfg.tag,
    target_commitish: cfg.source,
    draft: false,
    prerelease: true,
    assets: [...files].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      digest: `sha256:${hash(bytes)}`,
    })),
  };
  return { files, release };
}
function refreshAsset(release, files, name) {
  const bytes = files.get(name);
  Object.assign(
    release.assets.find((asset) => asset.name === name),
    { size: bytes.length, digest: `sha256:${hash(bytes)}` },
  );
}
test("requires exact repository, tag, source and run provenance", () => {
  for (const [key, value] of [
    ["GH_REPO", "other/repo"],
    ["RELEASE_TAG", "vwrong"],
    ["SOURCE_SHA", "main"],
    ["GITHUB_RUN_ID", ""],
    ["RELEASE_VERSION", "../escape"],
  ])
    assert.throws(() => config({ ...env, [key]: value }));
});
test("strict checksums reject traversal, malformed SHA and duplicate entries", () => {
  for (const text of [
    `${"a".repeat(64)}  ../file\n`,
    "wrong  file\n",
    `${"a".repeat(64)}  file\n${"b".repeat(64)}  file\n`,
  ])
    assert.throws(() => checksums(Buffer.from(text)));
});
test("published original requires exact source, hashes, receipt and complete Linux/Android set", () => {
  const good = fixture();
  assert(verifyOriginal(good.release, good.files, cfg).has("SHA256SUMS"));
  for (const mutate of [
    ({ release }) => {
      release.target_commitish = "b".repeat(40);
    },
    ({ release }) => {
      release.assets[0].digest = `sha256:${"0".repeat(64)}`;
    },
    ({ files }) => {
      files.set("nightly-linux.yml", Buffer.from("changed"));
    },
    ({ files, release }) => {
      const name = "RELEASE-RECEIPT.txt";
      files.set(name, Buffer.from(files.get(name).toString().replace(cfg.source, "b".repeat(40))));
      refreshAsset(release, files, name);
    },
    ({ files, release }) => {
      const name = "SHA256SUMS";
      files.set(
        name,
        Buffer.from(files.get(name).toString().replace("nightly-linux.yml", "../escape")),
      );
      refreshAsset(release, files, name);
    },
    ({ files, release }) => {
      files.delete("install-linux.sh");
      release.assets = release.assets.filter((asset) => asset.name !== "install-linux.sh");
    },
    ({ files, release }) => {
      files.set("unexpected.exe", Buffer.from("extra"));
      release.assets.push({
        name: "unexpected.exe",
        size: 5,
        digest: `sha256:${hash(Buffer.from("extra"))}`,
      });
    },
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() => verifyOriginal(bad.release, bad.files, cfg));
  }
});
test("original receipt remains valid with a partial Windows retry", () => {
  const { files, release } = fixture();
  const name = windowsNames(cfg.version)[0];
  files.set(name, Buffer.from("installer"));
  release.assets.push({ name, size: 9, digest: `sha256:${hash(files.get(name))}` });
  assert(verifyOriginal(release, files, cfg).has("RELEASE-RECEIPT.txt"));
});
test("Windows feed and CLI archive bind version, installer name and bytes", () => {
  const names = windowsNames(cfg.version);
  const files = new Map(names.map((name) => [name, Buffer.from("payload")]));
  const feed = {
    version: cfg.version,
    path: names[0],
    sha512: hash(files.get(names[0]), "sha512"),
    files: [{ url: names[0], sha512: hash(files.get(names[0]), "sha512"), size: 7 }],
  };
  const encode = () => files.set("nightly.yml", Buffer.from(JSON.stringify(feed)));
  encode();
  validateWindows(files, cfg);
  const root = `t3-${cfg.version}-win32-x64/`;
  validateCliArchive([`${root}t3.exe`], Buffer.from(`MZ ${cfg.version}`), cfg);
  assert.throws(() =>
    validateCliArchive([`${root}t3.exe`], Buffer.from("MZ 0.0.0-nightly.20261030.1"), cfg),
  );
  assert.throws(() =>
    validateCliArchive([`${root}../t3.exe`], Buffer.from(`MZ ${cfg.version}`), cfg),
  );
  for (const [key, value] of [
    ["version", "0.0.0"],
    ["path", "../installer.exe"],
    ["sha512", "wrong"],
  ]) {
    const old = feed[key];
    feed[key] = value;
    encode();
    assert.throws(() => validateWindows(files, cfg));
    feed[key] = old;
  }
  encode();
  files.set("extra.exe", Buffer.from("extra"));
  assert.throws(() => validateWindows(files, cfg));
});
test("receipt rejects duplicate source fields and modified checksum blocks", () => {
  const { files } = fixture();
  const text = files.get("RELEASE-RECEIPT.txt").toString();
  assert.throws(() =>
    receipt(Buffer.from(`source_sha=${cfg.source}\n${text}`), cfg, files.get("SHA256SUMS")),
  );
  assert.throws(() => receipt(Buffer.from(text + "extra\n"), cfg, files.get("SHA256SUMS")));
});

test("retry accepts identical bytes and rejects any collision before upload", () => {
  const existing = new Map([["nightly.yml", Buffer.from("published")]]);
  assertCompatibleAppend(
    existing,
    new Map([
      ["nightly.yml", Buffer.from("published")],
      ["new.exe", Buffer.from("new")],
    ]),
  );
  assert.throws(() =>
    assertCompatibleAppend(existing, new Map([["nightly.yml", Buffer.from("changed")]])),
  );
});

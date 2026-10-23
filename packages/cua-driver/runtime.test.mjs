import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { cuaArchiveMembers, cuaRelease, cuaRuntimeDependencies } from "./runtime.mjs";
const hash = (x) => NodeCrypto.createHash("sha256").update(x).digest("hex");
const members = [
  ["cua-driver", Buffer.from("executable-fixture")],
  ["libcua_driver_sdk.so", Buffer.from("library-fixture")],
  ["cua_driver_node_runtime.node", Buffer.from("addon-fixture")],
];
function fixture(entries = members) {
  const blocks = [];
  for (const [name, content, type = "0"] of entries) {
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write(type, 156);
    blocks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  }
  const bytes = NodeZlib.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  const pinned = members.map(([name, content]) => ({
    name,
    bytes: content.length,
    sha256: hash(content),
  }));
  return {
    bytes,
    release: {
      format: "tar.gz",
      archiveBytes: bytes.length,
      archiveSha256: hash(bytes),
      executable: pinned[0],
      library: pinned[1],
      addon: pinned[2],
    },
  };
}
NodeTest.test("extracts all pinned regular Linux members with exact bytes", () => {
  const { bytes, release } = fixture();
  NodeAssert.deepEqual([...cuaArchiveMembers(bytes, release)], members);
});
NodeTest.test("rejects corruption before extraction", () => {
  const { bytes, release } = fixture();
  bytes[12] ^= 1;
  NodeAssert.throws(() => cuaArchiveMembers(bytes, release), /integrity/);
});
NodeTest.test(
  "rejects duplicate members, symlinks, missing members and incorrect member hashes",
  () => {
    for (const entries of [
      [...members, members[0]],
      members.map((x, i) => (i === 0 ? [...x, "2"] : x)),
      members.slice(1),
      members.map((x, i) => (i === 0 ? [x[0], Buffer.from("incorrect-bytes")] : x)),
    ]) {
      const { bytes, release } = fixture(entries);
      NodeAssert.throws(() => cuaArchiveMembers(bytes, release));
    }
  },
);
NodeTest.test(
  "ignores traversal and unrelated paths and never interprets them as pinned members",
  () => {
    const { bytes, release } = fixture([...members, ["../cua-driver", Buffer.from("untrusted")]]);
    NodeAssert.deepEqual([...cuaArchiveMembers(bytes, release)], members);
  },
);
NodeTest.test("maps only published platforms and never requests an unpublished npm SDK", () => {
  NodeAssert.equal(cuaRelease("linux", "arm64").triple, "linux-arm64-gnu");
  NodeAssert.equal(cuaRelease("linux", "x64").triple, "linux-x64-gnu");
  NodeAssert.equal(cuaRelease("win", "x64").triple, "win32-x64-msvc");
  NodeAssert.equal(cuaRelease("win32", "arm64"), undefined);
  NodeAssert.equal(cuaRelease("darwin", "arm64"), undefined);
  NodeAssert.deepEqual(
    cuaRuntimeDependencies({
      "@trycua/cua-driver": "workspace:*",
      "@trycua/cua-driver-linux-x64-gnu": "0.37.0",
      other: "1",
    }),
    { other: "1", "@ubjs/core": "0.31.0-3", "@ubjs/node": "0.31.0-3" },
  );
});

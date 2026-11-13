// @effect-diagnostics nodeBuiltinImport:off -- Pack-import regressions use isolated disposable filesystem fixtures.
import { describe, expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { importPetPack, validatePetPack } from "./PetPack.ts";

function pack() {
  const states = Object.fromEntries(
    ["idle", "working", "reading", "lookingAway", "waiting", "attention", "success", "error"].map(
      (name, row) => [name, { row, frames: 4, fps: 6, loop: false }],
    ),
  );
  const manifest = {
    schema: 1,
    name: "Milo",
    frameWidth: 128,
    frameHeight: 128,
    sheet: "pet.png",
    states,
  };
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(512, 16);
  png.writeUInt32BE(1024, 20);
  png[24] = 8;
  png[25] = 6;
  return { manifest, png };
}

describe("pet pack boundaries", () => {
  it("accepts the native grid and rejects file escape, unsafe names and missing states", () => {
    const { manifest, png } = pack();
    expect(validatePetPack(manifest, png).frameWidth).toBe(128);
    expect(() => validatePetPack({ ...manifest, sheet: "../pet.png" }, png)).toThrow();
    expect(() => validatePetPack({ ...manifest, name: "Milo\u202ehidden" }, png)).toThrow();
    expect(() => validatePetPack({ ...manifest, name: "Milo\u061chidden" }, png)).toThrow();
    expect(() =>
      validatePetPack({ ...manifest, states: { idle: manifest.states.idle } }, png),
    ).toThrow();
    expect(() => validatePetPack({ ...manifest, script: "run" }, png)).toThrow();
  });
  it("rejects oversized grids and non-alpha PNGs before image decoding", () => {
    const { manifest, png } = pack();
    png.writeUInt32BE(4096, 16);
    expect(() => validatePetPack(manifest, png)).toThrow();
    png.writeUInt32BE(512, 16);
    png[25] = 2;
    expect(() => validatePetPack(manifest, png)).toThrow();
  });
  it("does not persist undecodable images or open nonregular pack files", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pet-pack-"));
    const source = NodePath.join(root, "source");
    const destination = NodePath.join(root, "owned");
    const { manifest, png } = pack();
    try {
      await NodeFSP.mkdir(source);
      await NodeFSP.writeFile(NodePath.join(source, "pet.json"), JSON.stringify(manifest));
      await NodeFSP.writeFile(NodePath.join(source, "pet.png"), png);
      await expect(importPetPack(source, destination, () => false)).rejects.toThrow(
        "invalid-pack-image",
      );
      await expect(NodeFSP.stat(destination)).rejects.toThrow();
      await NodeFSP.unlink(NodePath.join(source, "pet.png"));
      await NodeFSP.mkdir(NodePath.join(source, "pet.png"));
      await expect(importPetPack(source, destination, () => true)).rejects.toThrow("invalid-pack");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});

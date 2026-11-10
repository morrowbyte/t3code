// @effect-diagnostics nodeBuiltinImport:off -- External Nix commands are fixture executables; no host Store or live roots are modified.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readNixRestoreClosure, retainedDesktopBytes } from "./desktopRestoreNix.ts";

const first = `/nix/store/${"0".repeat(32)}-crew-first`;
const second = `/nix/store/${"1".repeat(32)}-crew-second`;
const dependency = `/nix/store/${"2".repeat(32)}-shared-runtime`;
const member = (path: string, narSize: number) => ({
  path,
  narSize,
  narHash: `sha256-${"A".repeat(43)}=`,
});

async function setup() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crew-nix-restore-"));
  const previousPath = process.env.PATH;
  const metadata = NodePath.join(directory, "closure.json");
  const verified = NodePath.join(directory, "verified");
  const corrupt = NodePath.join(directory, "corrupt");
  await NodeFSP.writeFile(
    metadata,
    JSON.stringify({ [first]: member(first, 40), [dependency]: member(dependency, 60) }),
  );
  const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
  await NodeFSP.writeFile(
    NodePath.join(directory, "nix"),
    `#!/bin/sh\ncat ${shellWord(metadata)}\n`,
    { mode: 0o755 },
  );
  await NodeFSP.writeFile(
    NodePath.join(directory, "nix-store"),
    `#!/bin/sh\n[ ! -f ${shellWord(corrupt)} ] || exit 9\nprintf '%s\\n' "$2" >> ${shellWord(verified)}\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  return {
    metadata,
    verified,
    corrupt,
    async [Symbol.asyncDispose]() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await NodeFSP.rm(directory, { force: true, recursive: true });
    },
  };
}

describe("Nix desktop restore closure", () => {
  it("verifies every closure member and bounds retained bytes by unique Store paths", async () => {
    await using fixture = await setup();
    const closure = await readNixRestoreClosure(first, true);
    expect(closure.sizeBytes).toBe(100);
    expect((await NodeFSP.readFile(fixture.verified, "utf8")).trim().split("\n").sort()).toEqual(
      [first, dependency].sort(),
    );
    expect(
      retainedDesktopBytes([
        { sizeBytes: 100, nixClosure: closure.members },
        { sizeBytes: 110, nixClosure: [member(second, 50), member(dependency, 60)] },
      ]),
    ).toBe(150);
    expect(retainedDesktopBytes([{ sizeBytes: 100 }, { sizeBytes: 110 }])).toBe(210);
    await NodeFSP.writeFile(fixture.corrupt, "corrupt fixture");
    await expect(readNixRestoreClosure(first, true)).rejects.toThrow();
  });

  it("rejects incomplete closure membership and changes identity when the NAR identity changes", async () => {
    await using fixture = await setup();
    const original = await readNixRestoreClosure(first, true);
    await NodeFSP.writeFile(
      fixture.metadata,
      JSON.stringify([member(first, 41), member(dependency, 60)]),
    );
    expect((await readNixRestoreClosure(first, true)).sha256).not.toBe(original.sha256);
    await NodeFSP.writeFile(fixture.metadata, JSON.stringify([member(dependency, 60)]));
    await expect(readNixRestoreClosure(first, true)).rejects.toThrow("membership");
  });
});

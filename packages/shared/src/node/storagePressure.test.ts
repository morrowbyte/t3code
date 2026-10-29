import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { checkStorageAdmission, sampleStorage } from "./storagePressure.ts";

const GiB = 1024 ** 3;
function setup(nativePath: Path.Path) {
  const workspace = nativePath.resolve("/workspace");
  const missingWorktree = nativePath.join(workspace, "missing");
  const uuid = "00000000-0000-0000-0000-000000000001";
  const counters: Record<string, string> = {
    total_bytes: String(10 * GiB),
    bytes_used: String(8 * GiB),
    bytes_reserved: "0",
    bytes_pinned: "0",
    bytes_may_use: "0",
    bytes_readonly: "0",
  };
  const probe = {
    platform: "linux",
    statfs: vi.fn(async (path: string) => {
      if (path === missingWorktree) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { type: 0x9123683en, bsize: 1n, bavail: BigInt(50 * GiB) };
    }),
    readFile: vi.fn(async (path: string) => {
      if (path.endsWith("/error_stats"))
        return "write_errs 0\nread_errs 0\nflush_errs 0\ncorruption_errs 0\ngeneration_errs 0\n";
      const value = counters[path.split("/").at(-1)!];
      if (value === undefined) throw new Error("missing counter");
      return value;
    }),
    readDirectory: vi.fn(async () => ["1"]),
    run: vi.fn(async (command: string) =>
      command === "findmnt"
        ? JSON.stringify({ filesystems: [{ fstype: "btrfs", uuid }] })
        : `Overall:\n    Device unallocated: ${2 * GiB}\n`,
    ),
  };
  return { probe, counters, workspace, missingWorktree };
}

it.layer(NodePath.layer)("native storage samples", (it) => {
  it.effect("measures a missing worktree at its parent and shares one filesystem probe", () =>
    Effect.gen(function* () {
      const { probe, workspace, missingWorktree } = setup(yield* Path.Path);
      const samples = yield* Effect.promise(() =>
        sampleStorage([missingWorktree, workspace], probe),
      );
      expect(samples.map((sample) => sample.path)).toEqual([missingWorktree, workspace]);
      expect(probe.statfs).toHaveBeenCalledWith(workspace);
      expect(probe.statfs.mock.calls).toEqual([[missingWorktree], [workspace], [workspace]]);
      expect(samples[0]?.btrfs?.deviceUnallocatedBytes).toBe(2 * GiB);
      expect(probe.run.mock.calls.filter(([command]) => command === "btrfs")).toHaveLength(1);
    }),
  );

  it.effect("does not admit a known Btrfs volume when required counters are unavailable", () =>
    Effect.gen(function* () {
      const { probe, counters, workspace } = setup(yield* Path.Path);
      delete counters.bytes_may_use;
      const result = yield* Effect.promise(() =>
        checkStorageAdmission([workspace], 0, false, (paths) => sampleStorage(paths, probe)),
      );
      expect(result).toContain("Cannot check storage capacity");
      expect(result).toContain("missing counter");
    }),
  );

  it.effect("preserves statfs-only operation on Windows and non-Btrfs filesystems", () =>
    Effect.gen(function* () {
      for (const platform of ["win32", "linux"]) {
        const { probe, workspace } = setup(yield* Path.Path);
        probe.platform = platform;
        probe.statfs.mockResolvedValue({ type: 0n, bsize: 1n, bavail: BigInt(50 * GiB) });
        const samples = yield* Effect.promise(() => sampleStorage([workspace], probe));
        expect(samples).toEqual([{ path: workspace, availableBytes: 50 * GiB }]);
        expect(probe.run).not.toHaveBeenCalled();
        expect(probe.readFile).not.toHaveBeenCalled();
      }
    }),
  );
});

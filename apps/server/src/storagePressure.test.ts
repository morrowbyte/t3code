// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem probe in a disposable test directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkStorageAdmission, makeStoragePressure, sampleStorage } from "./storagePressure.ts";

const GiB = 1024 ** 3;
describe("storage pressure admission", () => {
  it("probes the actual filesystem of an isolated temporary directory", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-storage-probe-"));
    try {
      const [sample] = await sampleStorage([dir]);
      expect(sample?.path).toBe(dir);
      expect(sample!.availableBytes).toBeGreaterThanOrEqual(0);
    } finally {
      await NodeFSP.rm(dir, { recursive: true });
    }
  });
  it("blocks either volume, accounts for concurrent work and requires recovery headroom", async () => {
    const sample = async () => [
      { path: "work", availableBytes: 20 * GiB },
      { path: "data", availableBytes: 9 * GiB },
    ];
    expect(await checkStorageAdmission(["work", "data"], 0, false, sample)).toBeNull();
    expect(await checkStorageAdmission(["work", "data"], 0, true, sample)).toContain("data");
    expect(await checkStorageAdmission(["work", "data"], 2, false, sample)).toContain("data");
    expect(
      await checkStorageAdmission(["missing"], 0, false, async () => {
        throw new Error("unavailable");
      }),
    ).toContain("Cannot check");
  });
  it("serializes competing admissions and releases each reservation once", async () => {
    const guard = makeStoragePressure(async () => [{ path: "disk", availableBytes: 9 * GiB }]);
    const leases = await Promise.all([
      guard.acquire(["disk"]),
      guard.acquire(["disk"]),
      guard.acquire(["disk"]),
    ]);
    expect(leases.map((lease) => lease.message === null)).toEqual([true, true, false]);
    leases[0]!.release();
    leases[0]!.release();
    // Recovery hysteresis remains in effect after the failed reservation.
    expect((await guard.acquire(["disk"])).message).not.toBeNull();
  });
  it("holds the recovery threshold after a running volume becomes critical", async () => {
    let availableBytes = 3 * GiB;
    const guard = makeStoragePressure(async () => [{ path: "disk", availableBytes }]);
    expect(await guard.checkRunning(["disk"])).toContain("disk");
    availableBytes = 9 * GiB;
    expect(await guard.check(["disk"])).not.toBeNull();
    availableBytes = 11 * GiB;
    expect(await guard.check(["disk"])).toBeNull();
  });
});

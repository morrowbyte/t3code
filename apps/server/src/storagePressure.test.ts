// @effect-diagnostics nodeBuiltinImport:off -- Real filesystem probe in a disposable test directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { checkStorageAdmission, makeStoragePressure, sampleStorage } from "./storagePressure.ts";

const GiB = 1024 ** 3;
const btrfs = {
  deviceUnallocatedBytes: 2 * GiB,
  metadataTotalBytes: 10 * GiB,
  metadataUsedBytes: 8 * GiB,
  metadataReservedBytes: 0,
  metadataPinnedBytes: 0,
  metadataMayUseBytes: 0,
  metadataReadonlyBytes: 0,
  deviceErrors: 0,
};
describe("storage pressure admission", () => {
  it("blocks Btrfs metadata exhaustion even with fifty GiB reported free", async () => {
    const guard = makeStoragePressure(async () => [
      {
        path: "btrfs",
        availableBytes: 50 * GiB,
        btrfs: { ...btrfs, metadataUsedBytes: 9.5 * GiB },
      },
    ]);
    expect((await guard.check(["btrfs"]))?.message).toContain("Btrfs");
    expect((await guard.checkRunning(["btrfs"]))?.message).toContain("Btrfs");
  });
  it("counts metadata reservations and requires recovery headroom", async () => {
    let metadataMayUseBytes = 1.5 * GiB;
    const guard = makeStoragePressure(async () => [
      {
        path: "btrfs",
        availableBytes: 50 * GiB,
        btrfs: { ...btrfs, metadataMayUseBytes },
      },
    ]);
    expect((await guard.checkRunning(["btrfs"]))?.message).toContain("Btrfs");
    metadataMayUseBytes = Math.floor(0.9 * GiB);
    expect((await guard.check(["btrfs"]))?.message).toContain("Btrfs");
    metadataMayUseBytes = 0;
    expect(await guard.check(["btrfs"])).toBeNull();
  });
  it("permits Btrfs allocation headroom but blocks device errors", async () => {
    let deviceErrors = 0;
    const guard = makeStoragePressure(async () => [
      {
        path: "btrfs",
        availableBytes: 50 * GiB,
        btrfs: {
          ...btrfs,
          metadataUsedBytes: 9.5 * GiB,
          deviceUnallocatedBytes: 50 * GiB,
          deviceErrors,
        },
      },
    ]);
    expect(await guard.check(["btrfs"])).toBeNull();
    deviceErrors = 1;
    expect((await guard.check(["btrfs"]))?.message).toContain("device errors");
  });
  it("permits a healthy small Btrfs pool and detects its real metadata exhaustion", async () => {
    let metadataUsedBytes = 32 * 1024 ** 2;
    const guard = makeStoragePressure(async () => [
      {
        path: "small-btrfs",
        availableBytes: 28 * GiB,
        btrfs: {
          ...btrfs,
          deviceUnallocatedBytes: 30 * GiB,
          metadataTotalBytes: 256 * 1024 ** 2,
          metadataUsedBytes,
        },
      },
    ]);
    expect(await guard.check(["small-btrfs"])).toBeNull();
    expect(await guard.checkRunning(["small-btrfs"])).toBeNull();
    metadataUsedBytes = 250 * 1024 ** 2;
    expect((await guard.checkRunning(["small-btrfs"]))?.message).toContain("Btrfs");
    metadataUsedBytes = 32 * 1024 ** 2;
    expect(await guard.check(["small-btrfs"])).toBeNull();
  });
  it("blocks admission and running work on measurement failure until recovery is measured", async () => {
    let measurementFails = true;
    let availableBytes = 50 * GiB;
    const guard = makeStoragePressure(async () => {
      if (measurementFails) throw new Error("spawn findmnt EAGAIN");
      return [{ path: "disk", availableBytes }];
    });
    const failure = {
      code: "storage_measurement_failed",
      message: expect.stringContaining("spawn findmnt EAGAIN"),
    };
    expect(await guard.check(["disk"])).toMatchObject(failure);
    expect(await guard.checkRunning(["disk"])).toMatchObject(failure);
    const lease = await guard.acquire(["disk"]);
    expect(lease.failure).toMatchObject(failure);
    expect(lease.failure?.message).toContain("Capacity is unknown");
    expect(lease.failure?.message).not.toContain("Free disk space");
    lease.release();
    measurementFails = false;
    availableBytes = 9 * GiB;
    expect(await guard.check(["disk"])).toMatchObject({ code: "storage_pressure" });
    availableBytes = 11 * GiB;
    expect(await guard.check(["disk"])).toBeNull();
    const recovered = await guard.acquire(["disk"]);
    expect(recovered.failure).toBeNull();
    recovered.release();
  });
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
    expect(leases.map((lease) => lease.failure === null)).toEqual([true, true, false]);
    leases[0]!.release();
    leases[0]!.release();
    // Recovery hysteresis remains in effect after the failed reservation.
    expect((await guard.acquire(["disk"])).failure).not.toBeNull();
  });
  it("holds the recovery threshold after a running volume becomes critical", async () => {
    let availableBytes = 3 * GiB;
    const guard = makeStoragePressure(async () => [{ path: "disk", availableBytes }]);
    expect(await guard.checkRunning(["disk"])).toMatchObject({
      code: "storage_pressure",
      message: expect.stringContaining("Not enough free disk space at disk"),
    });
    availableBytes = 9 * GiB;
    expect(await guard.check(["disk"])).not.toBeNull();
    availableBytes = 11 * GiB;
    expect(await guard.check(["disk"])).toBeNull();
  });
});

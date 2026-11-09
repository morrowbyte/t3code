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
  it("keeps usable disks available despite transient Btrfs reservations and concurrent agents", async () => {
    const guard = makeStoragePressure(async () => [
      {
        path: "disk",
        availableBytes: 3 * GiB,
        btrfs: { ...btrfs, deviceUnallocatedBytes: 32 * GiB, metadataMayUseBytes: 10 * GiB },
      },
    ]);
    const leases = await Promise.all(Array.from({ length: 8 }, () => guard.acquire(["disk"])));
    expect(leases.every((lease) => lease.failure === null)).toBe(true);
    expect(await guard.checkRunning(["disk"])).toBeNull();
    for (const lease of leases) lease.release();
  });
  it("does not interrupt running work when storage telemetry is unavailable", async () => {
    const guard = makeStoragePressure(async () => {
      throw new Error("spawn findmnt EAGAIN");
    });
    expect(await guard.checkRunning(["disk"])).toBeNull();
  });
  it("still reports an exhausted volume when another volume cannot be measured", async () => {
    const guard = makeStoragePressure(async (paths) => {
      if (paths.includes("unreadable")) throw new Error("statfs EACCES");
      return [{ path: "full", availableBytes: 0 }];
    });
    expect(await guard.checkRunning(["unreadable", "full"])).toMatchObject({
      code: "storage_pressure",
      message: expect.stringContaining("full"),
    });
  });
  it("does not block on historical device errors or allocated metadata pressure", async () => {
    const guard = makeStoragePressure(async () => [
      {
        path: "btrfs",
        availableBytes: 50 * GiB,
        btrfs: {
          ...btrfs,
          deviceUnallocatedBytes: 0,
          metadataUsedBytes: 10 * GiB,
          deviceErrors: 3,
        },
      },
    ]);
    expect(await guard.check(["btrfs"])).toBeNull();
    expect(await guard.checkRunning(["btrfs"])).toBeNull();
  });
  it("preserves a small write reserve without imposing per-agent disk budgets", async () => {
    let availableBytes = 128 * 1024 ** 2;
    const guard = makeStoragePressure(async () => [{ path: "disk", availableBytes }]);
    expect(await guard.check(["disk"])).toMatchObject({ code: "storage_pressure" });
    expect(await guard.checkRunning(["disk"])).toBeNull();
    availableBytes = 32 * 1024 ** 2;
    expect(await guard.checkRunning(["disk"])).toMatchObject({ code: "storage_pressure" });
    availableBytes = GiB;
    expect(await guard.check(["disk"])).toBeNull();
    const lease = await guard.acquire(["disk"]);
    expect(lease.failure).toBeNull();
    lease.release();
    lease.release();
  });
  it("reports an unreadable filesystem at admission and recovers on the next check", async () => {
    let unreadable = true;
    const guard = makeStoragePressure(async () => {
      if (unreadable) throw new Error("statfs EACCES");
      return [{ path: "disk", availableBytes: GiB }];
    });
    expect(await guard.check(["disk"])).toMatchObject({
      code: "storage_measurement_failed",
      message: expect.stringContaining("statfs EACCES"),
    });
    expect(await guard.checkRunning(["disk"])).toBeNull();
    unreadable = false;
    expect(await guard.check(["disk"])).toBeNull();
  });
  it("checks each volume and probes the actual filesystem", async () => {
    expect(
      await checkStorageAdmission(["work", "data"], 0, false, async () => [
        { path: "work", availableBytes: GiB },
        { path: "data", availableBytes: 0 },
      ]),
    ).toContain("data");
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-storage-probe-"));
    try {
      const [sample] = await sampleStorage([dir]);
      expect(sample?.path).toBe(dir);
      expect(sample!.availableBytes).toBeGreaterThanOrEqual(0);
    } finally {
      await NodeFSP.rm(dir, { recursive: true });
    }
  });
});

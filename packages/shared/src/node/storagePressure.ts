// @effect-diagnostics nodeBuiltinImport:off -- Also runs before worktree dependencies are installed.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const GiB = 1024 ** 3;
const BTRFS_MAGIC = 0x9123683en;
const STOP_RESERVE_BYTES = 4 * GiB;
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface BtrfsStorageSample {
  readonly deviceUnallocatedBytes: number;
  readonly metadataTotalBytes: number;
  readonly metadataUsedBytes: number;
  readonly metadataReservedBytes: number;
  readonly metadataPinnedBytes: number;
  readonly metadataMayUseBytes: number;
  readonly metadataReadonlyBytes: number;
  readonly deviceErrors: number;
}

export interface StorageSample {
  readonly path: string;
  readonly availableBytes: number;
  readonly btrfs?: BtrfsStorageSample;
}

export interface StorageFailure {
  readonly code: "storage_pressure" | "storage_measurement_failed";
  readonly message: string;
}

export function storageMeasurementFailure(cause: unknown): StorageFailure {
  return {
    code: "storage_measurement_failed",
    message: `Cannot check storage capacity. Capacity is unknown; work is blocked for safety. Check that the working directory, T3 data directory and filesystem measurements are accessible, then try again. (${cause instanceof Error ? cause.message : String(cause)})`,
  };
}

interface StorageProbe {
  readonly platform: string;
  readonly statfs: (path: string) => Promise<{ type: bigint; bavail: bigint; bsize: bigint }>;
  readonly readFile: (path: string) => Promise<string>;
  readonly readDirectory: (path: string) => Promise<string[]>;
  readonly run: (command: string, args: string[]) => Promise<string>;
}

const nativeProbe: StorageProbe = {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Pre-install callers have no Effect runtime; tests inject this platform.
  platform: NodeOS.platform(),
  statfs: (path) => NodeFSP.statfs(path, { bigint: true }),
  readFile: (path) => NodeFSP.readFile(path, "utf8"),
  readDirectory: (path) => NodeFSP.readdir(path),
  run: async (command, args) => {
    const { stdout } = await execFile(command, args, {
      encoding: "utf8",
      timeout: 1_500,
      maxBuffer: 128 * 1024,
      env: { ...process.env, LC_ALL: "C" },
      windowsHide: true,
    });
    return stdout;
  },
};

function byteCount(value: unknown, name: string): number {
  const parsed =
    typeof value === "string" && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid storage measurement: ${name}`);
  }
  return parsed;
}

async function existingFilesystem(path: string, probe: StorageProbe) {
  let current = NodePath.resolve(path);
  while (true) {
    try {
      return { path: current, stats: await probe.statfs(current) };
    } catch (cause) {
      const missing =
        cause !== null &&
        typeof cause === "object" &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR");
      const parent = NodePath.dirname(current);
      if (!missing || parent === current) throw cause;
      current = parent;
    }
  }
}

async function readBtrfs(
  path: string,
  uuid: string,
  probe: StorageProbe,
): Promise<BtrfsStorageSample> {
  const base = `/sys/fs/btrfs/${uuid}`;
  const counters = [
    "total_bytes",
    "bytes_used",
    "bytes_reserved",
    "bytes_pinned",
    "bytes_may_use",
    "bytes_readonly",
  ];
  const [usage, values, devices] = await Promise.all([
    probe.run("btrfs", ["filesystem", "usage", "--raw", path]),
    Promise.all(
      counters.map(async (name) =>
        byteCount(await probe.readFile(`${base}/allocation/metadata/${name}`), name),
      ),
    ),
    probe.readDirectory(`${base}/devinfo`),
  ]);
  const unallocated = /^\s*Device unallocated:\s+(\d+)\s*$/mu.exec(usage)?.[1];
  if (unallocated === undefined || values[0] === 0)
    throw new Error("Btrfs allocation measurement unavailable");
  const deviceIds = devices.filter((name) => /^\d+$/u.test(name));
  if (!deviceIds.length) throw new Error("Btrfs device measurements unavailable");
  const errors = await Promise.all(
    deviceIds.map(async (id) => {
      const text = await probe.readFile(`${base}/devinfo/${id}/error_stats`);
      const rows = [
        ...text.matchAll(
          /^(?:write_errs|read_errs|flush_errs|corruption_errs|generation_errs)\s+(\d+)\s*$/gmu,
        ),
      ];
      if (rows.length !== 5) throw new Error("Btrfs device error measurements unavailable");
      return rows.reduce((sum, row) => sum + byteCount(row[1], "device error count"), 0);
    }),
  );
  return {
    deviceUnallocatedBytes: byteCount(unallocated, "device unallocated"),
    metadataTotalBytes: values[0]!,
    metadataUsedBytes: values[1]!,
    metadataReservedBytes: values[2]!,
    metadataPinnedBytes: values[3]!,
    metadataMayUseBytes: values[4]!,
    metadataReadonlyBytes: values[5]!,
    deviceErrors: errors.reduce((sum, count) => sum + count, 0),
  };
}

/** Missing worktree paths are measured at their existing parent before checkout. */
export async function sampleStorage(
  paths: readonly string[],
  probe: StorageProbe = nativeProbe,
): Promise<StorageSample[]> {
  const filesystems = new Map<string, Promise<BtrfsStorageSample>>();
  return Promise.all(
    paths.map(async (path) => {
      const resolved = await existingFilesystem(path, probe);
      const sample = {
        path,
        availableBytes: byteCount(
          Number(resolved.stats.bavail * resolved.stats.bsize),
          "available bytes",
        ),
      };
      if (probe.platform !== "linux" || resolved.stats.type !== BTRFS_MAGIC) return sample;
      const mount: unknown = JSON.parse(
        await probe.run("findmnt", [
          "--json",
          "--target",
          resolved.path,
          "--output",
          "FSTYPE,UUID",
        ]),
      );
      const entry = (mount as { filesystems?: { fstype?: string; uuid?: string }[] })
        .filesystems?.[0];
      if (entry?.fstype !== "btrfs" || !/^[a-f0-9-]{36}$/iu.test(entry.uuid ?? "")) {
        throw new Error(`Cannot identify Btrfs filesystem at ${path}`);
      }
      const uuid = entry.uuid!;
      let pending = filesystems.get(uuid);
      if (!pending) {
        pending = readBtrfs(resolved.path, uuid, probe);
        filesystems.set(uuid, pending);
      }
      return { ...sample, btrfs: await pending };
    }),
  );
}

export function storagePressureMessage(
  sample: StorageSample,
  requiredBytes: number,
  previouslyBlocked = false,
): string | null {
  if (sample.availableBytes < requiredBytes) {
    return `Not enough free disk space at ${sample.path}: ${(sample.availableBytes / GiB).toFixed(2)} GiB available; at least ${(requiredBytes / GiB).toFixed(0)} GiB required. Free disk space and try again.`;
  }
  const btrfs = sample.btrfs;
  if (!btrfs) return null;
  for (const [name, value] of Object.entries(btrfs)) byteCount(value, name);
  if (!btrfs.metadataTotalBytes) throw new Error("Btrfs metadata size is unavailable");
  const headroom = Math.max(
    0,
    btrfs.metadataTotalBytes -
      btrfs.metadataUsedBytes -
      btrfs.metadataReservedBytes -
      btrfs.metadataPinnedBytes -
      btrfs.metadataMayUseBytes -
      btrfs.metadataReadonlyBytes,
  );
  const usedFraction = btrfs.metadataUsedBytes / btrfs.metadataTotalBytes;
  // Free data extents cannot replace metadata chunks; committed reservations also consume headroom.
  const minimumHeadroom = Math.min(
    (previouslyBlocked ? 1.5 : 1) * GiB,
    btrfs.metadataTotalBytes * (previouslyBlocked ? 0.12 : 0.1),
  );
  const tight = usedFraction >= (previouslyBlocked ? 0.88 : 0.9) || headroom < minimumHeadroom;
  if (btrfs.deviceErrors === 0 && !(btrfs.deviceUnallocatedBytes < 40 * GiB && tight)) return null;
  return `Btrfs storage pressure at ${sample.path}: ${(btrfs.deviceUnallocatedBytes / GiB).toFixed(2)} GiB device-unallocated, ${(headroom / GiB).toFixed(2)} GiB metadata headroom, ${(usedFraction * 100).toFixed(1)}% metadata used, ${btrfs.deviceErrors} device errors. Restore filesystem reserve before starting more work.`;
}

/** Failed Btrfs measurements never fall back to statfs-only admission. */
export async function checkStorageAdmissionFailure(
  paths: readonly string[],
  activeWork = 0,
  previouslyBlocked = false,
  sample: typeof sampleStorage = sampleStorage,
): Promise<StorageFailure | null> {
  const required = Math.max(
    previouslyBlocked ? 10 * GiB : 8 * GiB,
    STOP_RESERVE_BYTES + (Math.max(0, activeWork) + 1) * 2 * GiB,
  );
  try {
    for (const entry of await sample(paths)) {
      const message = storagePressureMessage(entry, required, previouslyBlocked);
      if (message) return { code: "storage_pressure", message };
    }
    return null;
  } catch (cause) {
    return storageMeasurementFailure(cause);
  }
}

export async function checkStorageAdmission(
  paths: readonly string[],
  activeWork = 0,
  previouslyBlocked = false,
  sample: typeof sampleStorage = sampleStorage,
): Promise<string | null> {
  return (
    (await checkStorageAdmissionFailure(paths, activeWork, previouslyBlocked, sample))?.message ??
    null
  );
}

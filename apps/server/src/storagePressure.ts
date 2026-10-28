// @effect-diagnostics nodeBuiltinImport:off -- Effect FileSystem does not expose free-space queries.
import * as NodeFSP from "node:fs/promises";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const GiB = 1024 ** 3;
/** Keep room for the app database and for work already in progress. */
const STOP_RESERVE_BYTES = 4 * GiB;
const ADMISSION_RESERVE_BYTES = 8 * GiB;
const RECOVERY_RESERVE_BYTES = 10 * GiB;
const ACTIVE_WORK_BUDGET_BYTES = 2 * GiB;

export interface StorageSample {
  readonly path: string;
  readonly availableBytes: number;
}

/** statfs resolves the filesystem for each actual path, including mount points. */
export async function sampleStorage(paths: readonly string[]): Promise<StorageSample[]> {
  return Promise.all(
    paths.map(async (path) => {
      const stats = await NodeFSP.statfs(path, { bigint: true });
      return { path, availableBytes: Number(stats.bavail * stats.bsize) };
    }),
  );
}

function storagePressureMessage(sample: StorageSample, requiredBytes: number): string {
  const available = (sample.availableBytes / GiB).toFixed(2);
  const required = (requiredBytes / GiB).toFixed(0);
  return `Not enough free disk space at ${sample.path}: ${available} GiB available; at least ${required} GiB required. Free disk space and try again.`;
}

/** A failed measurement is deliberately not interpreted as available capacity. */
export async function checkStorageAdmission(
  paths: readonly string[],
  activeWork: number,
  previouslyBlocked = false,
  sample: typeof sampleStorage = sampleStorage,
): Promise<string | null> {
  const required = Math.max(
    previouslyBlocked ? RECOVERY_RESERVE_BYTES : ADMISSION_RESERVE_BYTES,
    STOP_RESERVE_BYTES + (Math.max(0, activeWork) + 1) * ACTIVE_WORK_BUDGET_BYTES,
  );
  try {
    const samples = await sample(paths);
    const insufficient = samples.find((entry) => entry.availableBytes < required);
    return insufficient ? storagePressureMessage(insufficient, required) : null;
  } catch (cause) {
    return `Cannot check free disk space. Check that the working directory and T3 data directory are accessible, then try again. (${cause instanceof Error ? cause.message : String(cause)})`;
  }
}

export interface StoragePressureGuard {
  readonly check: (paths: readonly string[]) => Promise<string | null>;
  readonly checkRunning: (paths: readonly string[]) => Promise<string | null>;
  readonly acquire: (
    paths: readonly string[],
  ) => Promise<{ message: string | null; release: () => void }>;
}

export class StoragePressure extends Context.Service<StoragePressure, StoragePressureGuard>()(
  "t3/storagePressure",
) {}

/** Retain the recovery threshold until a fresh measurement succeeds above it. */
export function makeStoragePressure(
  sample: typeof sampleStorage = sampleStorage,
): StoragePressureGuard {
  const blockedPaths = new Set<string>();
  let active = 0;
  let tail = Promise.resolve();
  const check = async (paths: readonly string[]) => {
    const message = await checkStorageAdmission(
      paths,
      active,
      paths.some((path) => blockedPaths.has(path)),
      sample,
    );
    for (const path of paths) {
      if (message === null) blockedPaths.delete(path);
      else blockedPaths.add(path);
    }
    return message;
  };
  return {
    check,
    acquire: async (paths) => {
      let unlock!: () => void;
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      await previous;
      try {
        const message = await check(paths);
        if (message !== null) return { message, release: () => {} };
        active += 1;
        let released = false;
        return {
          message: null,
          release: () => {
            if (!released) {
              released = true;
              active -= 1;
            }
          },
        };
      } finally {
        unlock();
      }
    },
    checkRunning: async (paths) => {
      try {
        const insufficient = (await sample(paths)).find(
          (entry) => entry.availableBytes < STOP_RESERVE_BYTES,
        );
        if (!insufficient) return null;
        blockedPaths.add(insufficient.path);
        return storagePressureMessage(insufficient, STOP_RESERVE_BYTES);
      } catch (cause) {
        for (const path of paths) blockedPaths.add(path);
        return `Cannot check free disk space; stopping work. ${cause instanceof Error ? cause.message : String(cause)}`;
      }
    },
  };
}

export const layer = Layer.succeed(StoragePressure, makeStoragePressure());
export const layerTest = Layer.succeed(StoragePressure, {
  check: async () => null,
  checkRunning: async () => null,
  acquire: async () => ({ message: null, release: () => {} }),
});

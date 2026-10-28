import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  checkStorageAdmission,
  sampleStorage,
  storagePressureMessage,
} from "@t3tools/shared/node/storagePressure";

export { checkStorageAdmission, sampleStorage } from "@t3tools/shared/node/storagePressure";
export type { StorageSample } from "@t3tools/shared/node/storagePressure";

const GiB = 1024 ** 3;
/** Keep room for the app database and for work already in progress. */
const STOP_RESERVE_BYTES = 4 * GiB;

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
        for (const entry of await sample(paths)) {
          const message = storagePressureMessage(entry, STOP_RESERVE_BYTES);
          if (message) {
            blockedPaths.add(entry.path);
            return message;
          }
        }
        return null;
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

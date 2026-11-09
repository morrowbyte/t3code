import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  checkStorageAdmissionFailure,
  sampleStorage,
  storagePressureMessage,
  type StorageFailure,
} from "@t3tools/shared/node/storagePressure";

export { checkStorageAdmission, sampleStorage } from "@t3tools/shared/node/storagePressure";
export type { StorageSample, StorageFailure } from "@t3tools/shared/node/storagePressure";

const STOP_RESERVE_BYTES = 64 * 1024 ** 2;

export interface StoragePressureGuard {
  readonly check: (paths: readonly string[]) => Promise<StorageFailure | null>;
  readonly checkRunning: (paths: readonly string[]) => Promise<StorageFailure | null>;
  readonly acquire: (
    paths: readonly string[],
  ) => Promise<{ failure: StorageFailure | null; release: () => void }>;
}

export class StoragePressure extends Context.Service<StoragePressure, StoragePressureGuard>()(
  "t3/storagePressure",
) {}

export function makeStoragePressure(
  sample: typeof sampleStorage = sampleStorage,
): StoragePressureGuard {
  const check = (paths: readonly string[]) => checkStorageAdmissionFailure(paths, 0, false, sample);
  return {
    check,
    acquire: async (paths) => ({ failure: await check(paths), release: () => {} }),
    checkRunning: async (paths) => {
      for (const path of paths) {
        try {
          for (const entry of await sample([path])) {
            const message = storagePressureMessage(entry, STOP_RESERVE_BYTES);
            if (message) return { code: "storage_pressure", message };
          }
        } catch {
          // Missing telemetry is not evidence of an exhausted filesystem.
        }
      }
      return null;
    },
  };
}

export const layer = Layer.succeed(StoragePressure, makeStoragePressure());
export const layerTest = Layer.succeed(StoragePressure, {
  check: async () => null,
  checkRunning: async () => null,
  acquire: async () => ({ failure: null, release: () => {} }),
});

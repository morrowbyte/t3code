import { CUA_VERSION, CUA_CONTRACT, CUA_SOURCE, cuaRelease } from "@trycua/cua-driver/runtime";

export { cuaRelease };
export const CUA_RELEASE = {
  version: CUA_VERSION,
  sdkVersion: CUA_VERSION,
  contractVersion: CUA_CONTRACT,
  sourceCommit: CUA_SOURCE,
} as const;

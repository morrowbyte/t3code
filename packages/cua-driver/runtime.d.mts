export interface CuaMember {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}
export interface CuaRelease {
  readonly triple: string;
  readonly archive: string;
  readonly format: "zip" | "tar.gz";
  readonly archiveBytes: number;
  readonly archiveSha256: string;
  readonly executable: CuaMember;
  readonly library: CuaMember;
  readonly addon: CuaMember;
}
export const CUA_VERSION: string;
export const CUA_CONTRACT: string;
export const CUA_SOURCE: string;
export const CUA_RELEASES: Readonly<Record<string, CuaRelease>>;
export function cuaRuntimeDependencies(
  dependencies: Readonly<Record<string, string>>,
): Record<string, string>;
export function cuaRelease(platform: string, arch: string): CuaRelease | undefined;
export function verifyCuaBytes(
  bytes: Uint8Array,
  expected: { bytes: number; sha256: string; name?: string },
): void;
export function cuaArchiveMembers(bytes: Buffer, release: CuaRelease): Map<string, Buffer>;
export function downloadCuaArchive(
  release: CuaRelease,
  options?: { archivePath?: string; signal?: AbortSignal },
): Promise<Buffer>;
export function stageCuaRuntime(options: {
  destination: string;
  platform: string;
  arch: string;
  archivePath?: string;
  sdkRoot?: string;
  signal?: AbortSignal;
}): Promise<{ release: CuaRelease; executable: string; sdkRoot: string } | undefined>;

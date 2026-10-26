// @effect-diagnostics nodeBuiltinImport:off - SEA loads external runtime modules from the real filesystem.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

// A SEA executable cannot import file-backed ESM packages. The runtime entry is
// pure JS; loading it must not initialize the native driver or an SDK session.
const moduleBase = import.meta.url.replace(/\.asar\//u, ".asar.unpacked/");
const manifest = NodeModule.findPackageJSON("@trycua/cua-driver", moduleBase);
if (!manifest) throw new Error("The packaged Cua runtime is missing.");
const runtime: typeof import("@trycua/cua-driver/runtime") = NodeModule.createRequire(moduleBase)(
  NodePath.join(NodePath.dirname(manifest), "runtime.mjs"),
);

export const { cuaRelease, cuaArchiveMembers, stageCuaRuntime, verifyCuaBytes } = runtime;
export const CUA_RELEASE = {
  version: runtime.CUA_VERSION,
  sdkVersion: runtime.CUA_VERSION,
  contractVersion: runtime.CUA_CONTRACT,
  sourceCommit: runtime.CUA_SOURCE,
} as const;

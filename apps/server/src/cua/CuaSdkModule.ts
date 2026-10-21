// @effect-diagnostics nodeBuiltinImport:off - Native package loading is a filesystem-backed Node boundary, including SEA.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { WINDOWS_CUA_RELEASE } from "./cuaRelease.ts";

type CuaSdkModule = Pick<typeof import("@trycua/cua-driver/embedded"), "EmbeddedCuaDriverHost">;

// UniFFI opens the DLL itself, outside Electron's patched fs. The entire SDK
// closure must therefore resolve from the real .unpacked tree on Windows.
const moduleBase = import.meta.url.replace(/\.asar\//u, ".asar.unpacked/");
const requireForCua = NodeModule.createRequire(moduleBase);

export const loadCuaSdk = (): CuaSdkModule => {
  // The published package has only an `import` export condition. Resolve its real
  // entry before require(esm), which also works with file-backed modules in SEA.
  const manifestPath = NodeModule.findPackageJSON("@trycua/cua-driver", moduleBase);
  if (!manifestPath) throw new Error("The packaged Cua SDK is missing.");
  const manifest: unknown = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    manifest.version !== WINDOWS_CUA_RELEASE.sdkVersion
  )
    throw new Error("The packaged Cua SDK does not match the pinned driver.");
  const sdk: unknown = requireForCua(
    NodePath.join(NodePath.dirname(manifestPath), "dist", "embedded.js"),
  );
  if (
    typeof sdk !== "object" ||
    sdk === null ||
    !("EmbeddedCuaDriverHost" in sdk) ||
    typeof sdk.EmbeddedCuaDriverHost !== "function"
  )
    throw new Error("The packaged Cua SDK has no embedded host.");
  return sdk as CuaSdkModule;
};

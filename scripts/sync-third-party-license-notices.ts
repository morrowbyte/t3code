// @effect-diagnostics nodeBuiltinImport:off - This is a build-time filesystem script.

import * as NodePath from "node:path";

import {
  generateThirdPartyLicenseManifest,
  syncThirdPartyLicenseNotices,
} from "./lib/third-party-licenses.ts";

const configFile = NodePath.resolve("third-party-licenses.config.json");

if (process.argv.includes("--check")) {
  await generateThirdPartyLicenseManifest({
    configFile,
    bundleName: "web",
    packageManifests: [
      { bundle: "web", path: NodePath.resolve("apps/web/package.json") },
      { bundle: "server", path: NodePath.resolve("apps/server/package.json") },
      { bundle: "desktop", path: NodePath.resolve("apps/desktop/package.json") },
    ],
  });
} else {
  await syncThirdPartyLicenseNotices(configFile);
}

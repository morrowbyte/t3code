// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import { isEntrypoint } from "./entrypoint.ts";

// Loads the CLI outside the launcher's module graph. Packaged builds embed it as a raw asset.
async function loadCliMain(): Promise<typeof import("./binMain.ts")> {
  if (!NodeSea.isSea()) return import("./binMain.ts");

  // Keep the executable's module URL so the CLI finds the web client and native packages beside it.
  const require = NodeModule.createRequire(import.meta.url);
  // require() resolves links in the executable path, such as a Windows junction.
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset("binMain.mjs")),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as typeof import("./binMain.ts");
  } finally {
    hook.deregister();
  }
}

function ignoreOutputError(): void {}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Logs go to stdout and stderr, which may be a closed desktop launcher pipe or a log file on
  // a full disk. Node emits a failed write as an unhandled stream error that crashes the process
  // and skips shutdown, so drop the line instead.
  process.stdout.on("error", ignoreOutputError);
  process.stderr.on("error", ignoreOutputError);

  const launcher =
    process.argv[2] === "__service-launcher" ? await import("./cli/serviceLauncher.ts") : undefined;
  const launcherOptions = launcher?.parseServiceLauncherArgs(process.argv.slice(3));
  const command = process.argv[2];
  if (command === "--crew-desktop-restore-probe") {
    try {
      const { readFile } = await import("node:fs/promises");
      const metadata = JSON.parse(
        await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
      ) as { version?: unknown; t3codeRestore?: Record<string, unknown> };
      if (
        typeof metadata.version !== "string" ||
        !metadata.t3codeRestore ||
        typeof metadata.t3codeRestore !== "object" ||
        Array.isArray(metadata.t3codeRestore)
      )
        throw new Error("No desktop restore metadata");
      process.stdout.write(
        `${JSON.stringify({ ...metadata.t3codeRestore, version: metadata.version })}\n`,
      );
    } catch {
      process.exitCode = 2;
    }
  } else if (launcher !== undefined && launcherOptions !== undefined) {
    await launcher.runServiceLauncherCli(launcherOptions);
  } else if (command === "cua-session-mcp") {
    const { runCuaSessionMcp } = await import("./cua/CuaSessionMcp.ts");
    await runCuaSessionMcp(process.argv.slice(3));
  } else if (command === "editor-follow-acp") {
    const { runEditorFollowAcp } = await import("./integrations/editorLink/EditorFollowAcp.ts");
    if (process.argv.length !== 5)
      throw new Error("Usage: t3 editor-follow-acp PROJECT PRIVATE_QUEUE");
    await runEditorFollowAcp(process.argv[3]!, process.argv[4]!);
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}

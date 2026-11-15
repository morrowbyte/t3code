/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * These, the view-only editor-follow ACP agent and the managed-token helper dispatch before the
 * full CLI graph loads; everything else defers to the real CLI in ./binCli.ts.
 */
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
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__cursor-sdk-worker") {
    const { runCursorSdkWorker } = await import("@t3tools/provider-cursor/server/CursorSdkWorker");
    await runCursorSdkWorker();
    process.exit(0);
  } else if (command === "--crew-desktop-restore-probe") {
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
  } else if (command === "--crew-desktop-restore-controller") {
    if (process.argv.length !== 5) {
      process.exitCode = 2;
    } else {
      try {
        const { runDesktopRestoreController } = await import("@t3tools/shared/desktopRestore");
        await runDesktopRestoreController({
          baseDir: process.argv[3]!,
          transactionId: process.argv[4]!,
        });
      } catch {
        process.exitCode = 1;
      }
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
  } else if (command === "__document-text") {
    const { extractDocumentText } = await import("./provider/documentTextWorker.ts");
    try {
      process.stdout.write(await extractDocumentText(process.argv[3]!, process.argv[4]!));
    } catch (error) {
      if (error instanceof Error && "code" in error && /^E[A-Z0-9]+$/.test(String(error.code))) {
        throw error;
      }
      // Exit 2 identifies document rejections; OS and process failures remain retryable.
      process.exitCode = 2;
    }
  } else if (command === "__managed-chatgpt-token") {
    const { runManagedChatGptTokenCli } = await import("./cli/managedChatGptToken.ts");
    await runManagedChatGptTokenCli(process.argv.slice(3));
  } else if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}

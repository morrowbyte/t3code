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

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  const command = process.argv[2];
  // Guard sockets before either dispatch path can load outbound-capable modules.
  const { ignoreMacosTypeOfServiceEinval } = await import("./outboundHttp.ts");
  ignoreMacosTypeOfServiceEinval();
  if (command === "__service-launcher" && process.argv.length === 3) {
    const { runServiceLauncherCli } = await import("./cli/serviceLauncher.ts");
    await runServiceLauncherCli();
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

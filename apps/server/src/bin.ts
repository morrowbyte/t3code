/**
 * Every ACP agent spawns `t3 acp-mcp-bridge` while opening its session, and terminal-fallback
 * agents run `t3 acp-mcp-call` per tool call, so their startup sits on first-message latency.
 * These, the view-only editor-follow ACP agent and the managed-token helper dispatch before the
 * full CLI graph loads; everything else defers to the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { enableCliCompileCache } from "./cliCompileCache.ts";

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
  if (command === "--crew-desktop-restore-probe") {
    try {
      // @effect-diagnostics-next-line nodeBuiltinImport:off -- Probe bundled metadata before loading CLI services.
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
    enableCliCompileCache();
    // Windows desktop launches without stdin; attach before reading, except on fast paths using pipes.
    const { attachConsoleStdin } = await import("./cli/consoleStdin.ts");
    attachConsoleStdin();
    const importStart = performance.now();
    const { runCli } = await import("./binCli.ts");
    if (process.env.T3CODE_STARTUP_PROFILE_DIR) {
      performance.measure("server.import.binCli", { start: importStart });
    }
    runCli();
  }
}

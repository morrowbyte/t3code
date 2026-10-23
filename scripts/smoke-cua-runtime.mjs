/* oxlint-disable t3code/no-global-process-runtime -- This standalone CI process selects its own native target, outside Effect. */
// Native ABI and authenticated MCP smoke; no desktop input or screenshots.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import { stageCuaRuntime, cuaRelease } from "../packages/cua-driver/runtime.mjs";

const prefix = NodePath.join(NodeOS.tmpdir(), "t3-cua-smoke-");
const probing = process.argv[2] === "--probe";
const directory = probing ? process.argv[3] : await NodeFSP.mkdtemp(prefix);
if (!directory || !NodePath.resolve(directory).startsWith(NodePath.resolve(prefix)))
  throw Error("Unexpected Cua smoke path");
if (!probing) {
  try {
    await stageCuaRuntime({
      destination: directory,
      platform: process.platform,
      arch: process.arch,
    });
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [NodeURL.fileURLToPath(import.meta.url), "--probe", directory],
      { stdio: "inherit", windowsHide: true, timeout: 60000 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw Error("Cua native probe subprocess failed");
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
} else {
  let host, child;
  try {
    const release = cuaRelease(process.platform, process.arch);
    const stage = release
      ? {
          release,
          sdkRoot: NodePath.join(directory, "node_modules/@trycua/cua-driver"),
          executable: NodePath.join(
            directory,
            "node_modules/@trycua",
            "cua-driver-" + release.triple,
            release.executable.name,
          ),
        }
      : undefined;
    if (!stage) throw Error("No published Cua target for this runner");
    const { EmbeddedCuaDriverHost } = await import(
      NodeURL.pathToFileURL(NodePath.join(stage.sdkRoot, "dist/embedded.js")).href
    );
    host = new EmbeddedCuaDriverHost(stage.executable, "com.morrowbyte.t3code");
    const connection = await host.start({ signal: AbortSignal.timeout(15000) });
    if (connection.driverVersion !== "0.38.0" || connection.contractVersion !== "0.8.0")
      throw Error("Cua version mismatch");
    child = NodeChildProcess.spawn(
      process.execPath,
      [
        NodeURL.fileURLToPath(new URL("../apps/server/src/bin.ts", import.meta.url)),
        "cua-session-mcp",
        connection.mcp.command,
        ...connection.mcp.args,
      ],
      {
        stdio: ["pipe", "pipe", "inherit"],
        windowsHide: true,
        env: {
          ...process.env,
          ...Object.fromEntries(connection.mcp.environment.map(({ name, value }) => [name, value])),
        },
      },
    );
    const pending = new Map();
    let id = 0;
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
    });
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
    const request = (method, params) =>
      new Promise((resolve, reject) => {
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(Error("MCP timeout: " + method));
        }, 15000);
        pending.set(key, (result) => {
          pending.delete(key);
          clearTimeout(timer);
          if (result.error) reject(Error(result.error.message));
          else resolve(result.result);
        });
        send({ jsonrpc: "2.0", id: key, method, params });
      });
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t3-cua-runtime-smoke", version: "1" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const inventory = await request("tools/list", {});
    const session = await request("tools/call", { name: "get_session", arguments: {} });
    if (
      session.isError ||
      !["run_script", "run_steps", "get_guide", "get_window_state"].every((name) =>
        inventory.tools.some((tool) => tool.name === name),
      )
    )
      throw Error("MCP session or required tools unavailable");
    child.stdin.end();
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (exit !== 0) throw Error("Cua MCP relay failed to shut down cleanly");
    lines.close();
    console.log(
      JSON.stringify({
        status: "pass",
        triple: stage.release.triple,
        driverVersion: connection.driverVersion,
        contractVersion: connection.contractVersion,
        toolCount: inventory.tools.length,
        implicitSessionActive: session.structuredContent?.state === "active",
        sameTransportMotionConfirmed: true,
        nativeInputDispatched: false,
      }),
    );
  } finally {
    if (child?.exitCode === null) child.kill();
    if (host) {
      await host.stop({ signal: AbortSignal.timeout(10000) });
      host.uniffiDestroy();
    }
  }
}

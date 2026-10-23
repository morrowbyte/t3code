// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - isolated stdio subprocess with a bootstrap watchdog, outside Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import { createCuaSessionRelay } from "./CuaSessionRelay.ts";

export const runCuaSessionMcp = async (args: ReadonlyArray<string>): Promise<void> => {
  const command = args[0];
  if (!command) throw new Error("Missing managed Cua MCP command");
  const child = NodeChildProcess.spawn(command, args.slice(1), {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  let stopped = false;
  let bootstrapTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(bootstrapTimer);
    child.stdin.end();
    child.kill();
  };
  child.stdin.on("error", () => {
    if (!stopped) process.exitCode = 1;
    stop();
  });
  const relay = createCuaSessionRelay({
    bootstrapId: `t3-cua-${NodeCrypto.randomUUID()}`,
    ready: () => clearTimeout(bootstrapTimer),
    send: (message) => {
      if (
        (message as { params?: { name?: string } }).params?.name === "start_session" &&
        !bootstrapTimer
      )
        bootstrapTimer = setTimeout(() => {
          relay.abort();
        }, 15000);
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    receive: (message) => {
      // A confirmed bootstrap is consumed internally; subsequent messages retain
      // their original IDs, image blocks and tool-result metadata.
      process.stdout.write(`${JSON.stringify(message)}\n`);
    },
    fail: (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      stop();
    },
  });
  const agentLines = NodeReadline.createInterface({ input: process.stdin });
  const driverLines = NodeReadline.createInterface({ input: child.stdout });
  agentLines.on("line", (line) => {
    try {
      relay.agent(JSON.parse(line));
    } catch {
      relay.abort();
    }
  });
  driverLines.on("line", (line) => {
    try {
      relay.driver(JSON.parse(line));
    } catch {
      relay.abort();
    }
  });
  agentLines.once("close", stop);
  const onSignal = () => stop();
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code && !stopped) process.exitCode = code;
        resolve();
      });
    });
  } finally {
    stop();
    agentLines.close();
    driverLines.close();
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGINT", onSignal);
  }
};

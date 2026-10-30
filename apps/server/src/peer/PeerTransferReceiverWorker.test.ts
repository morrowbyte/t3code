// @effect-diagnostics nodeBuiltinImport:off
import * as NodeProcess from "node:process";

import { expect, it } from "vitest";

import { PeerTransferReceiverWorker } from "./PeerTransferReceiverWorker.ts";

const workerScript = `
  const readline = require("node:readline");
  let offset = 0;
  let state = "receiving";
  process.stdout.write("ready 1\\n");
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line === "status") return process.stdout.write("status " + state + " " + offset + "\\n");
    if (line.startsWith("write ")) {
      const [, position, hex] = line.split(" ");
      if (Number(position) !== offset) return process.stdout.write("error conflict\\n");
      offset += hex.length / 2;
      return process.stdout.write("ok\\n");
    }
    if (line.startsWith("publish ")) {
      state = "published";
      return process.stdout.write("ok\\n");
    }
    if (line === "release" || line === "abort") {
      process.stdout.write("ok cleanup-marked\\n", () => process.exit(0));
    }
  });
`;

it("keeps one helper alive through writes, publication and confirmed cleanup", async () => {
  const worker = await PeerTransferReceiverWorker.start(
    NodeProcess.execPath,
    ["-e", workerScript],
    5000,
  );
  try {
    await worker.write(0, Buffer.from([0, 255, 10]));
    expect(await worker.status()).toEqual({ state: "receiving", offset: 3 });
    await expect(worker.write(0, Buffer.from([1]))).rejects.toMatchObject({ reason: "conflict" });
    await worker.publish("file");
    expect(await worker.status()).toEqual({ state: "published", offset: 3 });
    await worker.cleanup("release");
  } finally {
    await worker.stop();
  }
});

it("fails closed on a malformed helper response and reaps the process", async () => {
  const script = `
    process.stdout.write("ready 1\\n");
    process.stdin.once("data", () => process.stdout.write("unexpected\\n"));
    process.stdin.resume();
  `;
  const worker = await PeerTransferReceiverWorker.start(NodeProcess.execPath, ["-e", script], 5000);
  try {
    await expect(worker.status()).rejects.toMatchObject({ reason: "protocol" });
    await expect(worker.status()).rejects.toMatchObject({ reason: "protocol" });
  } finally {
    await worker.stop();
  }
});

it("does not report cleanup as successful if the helper exits unsuccessfully", async () => {
  const script = `
    process.stdout.write("ready 1\\n");
    process.stdin.once("data", () => process.stdout.write("ok cleanup-marked\\n", () => process.exit(1)));
    process.stdin.resume();
  `;
  const worker = await PeerTransferReceiverWorker.start(NodeProcess.execPath, ["-e", script], 5000);
  try {
    await expect(worker.cleanup("abort")).rejects.toMatchObject({ reason: "exited" });
  } finally {
    await worker.stop();
  }
});

it("reports an unexpected process exit during a request", async () => {
  const script = `
    process.stdout.write("ready 1\\n");
    process.stdin.once("data", () => process.exit(2));
    process.stdin.resume();
  `;
  const worker = await PeerTransferReceiverWorker.start(NodeProcess.execPath, ["-e", script], 5000);
  try {
    await expect(worker.status()).rejects.toMatchObject({ reason: "exited" });
  } finally {
    await worker.stop();
  }
});

it("terminates a helper that does not answer", async () => {
  const script = `process.stdout.write("ready 1\\n"); process.stdin.resume();`;
  const worker = await PeerTransferReceiverWorker.start(NodeProcess.execPath, ["-e", script], 1000);
  try {
    await expect(worker.status()).rejects.toMatchObject({ reason: "timeout" });
  } finally {
    await worker.stop();
  }
});

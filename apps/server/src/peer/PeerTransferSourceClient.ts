// @effect-diagnostics nodeBuiltinImport:off -- This CLI reads the agent's file and writes its local socket directly.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeStreamPromises from "node:stream/promises";

const MAX_BYTES = 50 * 1024 * 1024;

class SubmissionFailure extends Error {}

export async function submitFile(socketPath: string, tokenPath: string, sourcePath: string) {
  const handle = await NodeFSP.open(
    sourcePath,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size))
      throw new SubmissionFailure("Source must be a regular file.");
    if (stat.size > MAX_BYTES) throw new SubmissionFailure("Source exceeds the 50 MiB limit.");
    const hash = NodeCrypto.createHash("sha256");
    const buffer = Buffer.alloc(256 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead === 0) throw new SubmissionFailure("Source changed during reading.");
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const token = (await NodeFSP.readFile(tokenPath, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new SubmissionFailure("Local transfer credential is invalid.");
    const socket = NodeNet.createConnection(socketPath);
    const response = new Promise<string>((resolve, reject) => {
      let data = "";
      let ended = false;
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        data += chunk;
        if (data.length > 64) socket.destroy(new Error("Invalid local transfer response."));
      });
      socket.once("end", () => {
        ended = true;
        resolve(data);
      });
      socket.once("error", reject);
      socket.once("close", () => {
        if (!ended) reject(new Error("Local transfer ended without acknowledgement."));
      });
    });
    try {
      const send = async () => {
        socket.write(`${token} ${stat.size} ${hash.digest("hex")}\n`);
        if (stat.size > 0) {
          await NodeStreamPromises.pipeline(
            handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }),
            socket,
            { end: false },
          );
        }
        socket.end();
      };
      const [, acknowledgement] = await Promise.all([send(), response]);
      const failures: Record<string, string> = {
        "error:invalid\n": "Local transfer submission was invalid.",
        "error:limit\n": "Source exceeds the 50 MiB limit.",
        "error:denied\n": "Agent permissions no longer allow this transfer.",
        "error:integrity\n": "Source bytes failed the size or SHA-256 check.",
        "error:storage\n": "Private local transfer staging failed.",
        "error:aborted\n": "Local transfer submission was aborted.",
      };
      if (acknowledgement !== "ok\n")
        throw new SubmissionFailure(
          failures[acknowledgement] ?? "Local transfer submission was refused.",
        );
    } finally {
      socket.destroy();
    }
  } finally {
    await handle.close();
  }
}

export async function runSourceClient(args: ReadonlyArray<string>) {
  if (args.length !== 3) {
    process.stderr.write("Usage: t3 file-transfer-submit SOCKET TOKEN_FILE SOURCE_FILE\n");
    process.exitCode = 2;
    return;
  }
  try {
    await submitFile(args[0]!, args[1]!, args[2]!);
    process.stdout.write("File submitted.\n");
  } catch (error) {
    process.stderr.write(
      error instanceof SubmissionFailure
        ? `${error.message}\n`
        : "File submission failed. Check the source file and transfer status.\n",
    );
    process.exitCode = 1;
  }
}

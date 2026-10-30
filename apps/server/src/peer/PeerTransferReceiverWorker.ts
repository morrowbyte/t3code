// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - bounded subprocess protocol watchdog.
import * as NodeChildProcess from "node:child_process";

type WorkerReason = "invalid" | "integrity" | "conflict" | "storage";

export class PeerTransferWorkerError extends Error {
  constructor(readonly reason: WorkerReason | "protocol" | "timeout" | "exited") {
    super(`Peer staging worker failed: ${reason}`);
  }
}

type Pending = {
  readonly resolve: (line: string) => void;
  readonly reject: (error: PeerTransferWorkerError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

export class PeerTransferReceiverWorker {
  private pending: Pending | undefined;
  private output = "";
  private failure: PeerTransferWorkerError | undefined;
  private readonly exited: Promise<number | null>;

  private constructor(
    private readonly child: NodeChildProcess.ChildProcessWithoutNullStreams,
    private readonly timeoutMs: number,
  ) {
    this.exited = new Promise((resolve) => {
      child.once("close", (code) => {
        this.fail(new PeerTransferWorkerError("exited"));
        resolve(code);
      });
    });
    child.once("error", () => this.fail(new PeerTransferWorkerError("exited")));
    child.stdin.on("error", () => this.fail(new PeerTransferWorkerError("exited")));
    child.stdout.on("error", () => this.fail(new PeerTransferWorkerError("exited")));
    child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      this.output += chunk.toString("utf8");
      if (this.output.length > 512) return this.fail(new PeerTransferWorkerError("protocol"));
      const newline = this.output.indexOf("\n");
      if (newline < 0) return;
      const line = this.output.slice(0, newline).replace(/\r$/, "");
      this.output = this.output.slice(newline + 1);
      if (!this.pending || this.output.length !== 0)
        return this.fail(new PeerTransferWorkerError("protocol"));
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.resolve(line);
    });
  }

  private fail(error: PeerTransferWorkerError) {
    this.failure ??= error;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.child.stdin.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }

  private response(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.pending) return Promise.reject(new PeerTransferWorkerError("protocol"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new PeerTransferWorkerError("timeout")),
        this.timeoutMs,
      );
      this.pending = { resolve, reject, timer };
    });
  }

  static async start(command: string, args: readonly string[], timeoutMs: number) {
    const child = NodeChildProcess.spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    const worker = new PeerTransferReceiverWorker(child, timeoutMs);
    const ready = await worker.response();
    if (ready !== "ready 1") {
      worker.fail(new PeerTransferWorkerError("protocol"));
      throw worker.failure;
    }
    return worker;
  }

  private async command(command: string): Promise<string> {
    if (this.pending) throw new PeerTransferWorkerError("protocol");
    const response = this.response();
    if (!this.pending) return response;
    this.child.stdin.write(`${command}\n`);
    const line = await response;
    if (/^error (invalid|integrity|conflict|storage)$/.test(line))
      throw new PeerTransferWorkerError(line.slice(6) as WorkerReason);
    return line;
  }

  async write(offset: number, bytes: Uint8Array) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      bytes.length === 0 ||
      bytes.length > 256 * 1024
    )
      throw new PeerTransferWorkerError("invalid");
    await this.expect(`write ${offset} ${Buffer.from(bytes).toString("hex")}`, "ok");
  }

  async publish(name: string) {
    if (!/^[a-z0-9-]{1,128}$/.test(name)) throw new PeerTransferWorkerError("invalid");
    await this.expect(`publish ${name}`, "ok");
  }

  async status() {
    const line = await this.command("status");
    const match = /^status (receiving|published|poisoned|released) (0|[1-9][0-9]*)$/.exec(line);
    if (!match || !Number.isSafeInteger(Number(match[2]))) {
      this.fail(new PeerTransferWorkerError("protocol"));
      throw this.failure;
    }
    return { state: match[1], offset: Number(match[2]) };
  }

  private async expect(command: string, expected: string) {
    if ((await this.command(command)) !== expected) {
      this.fail(new PeerTransferWorkerError("protocol"));
      throw this.failure;
    }
  }

  async cleanup(action: "abort" | "release") {
    await this.expect(action, "ok cleanup-marked");
    this.child.stdin.end();
    const exit = await Promise.race([
      this.exited,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          this.fail(new PeerTransferWorkerError("timeout"));
          reject(this.failure);
        }, this.timeoutMs);
        void this.exited.then(() => clearTimeout(timer));
      }),
    ]);
    if (exit !== 0) throw new PeerTransferWorkerError("exited");
  }

  stop() {
    this.fail(new PeerTransferWorkerError("exited"));
    return this.exited;
  }
}

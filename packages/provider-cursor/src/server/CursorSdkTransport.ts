// @effect-diagnostics nodeBuiltinImport:off -- Native IPC uses V8's size and cloneability checks.
import * as NodeV8 from "node:v8";
import type { AgentMessage, InteractionUpdate, RunResult, SDKUserMessage } from "@cursor/sdk";
import type { CursorAgentSdkProtocolLogEvent } from "./CursorAgentSdk.ts";
import type { CursorSdkWireAgentOptions, CursorSdkWireSendOptions } from "./CursorSdkCallbacks.ts";
import {
  CursorSdkRemoteError,
  cursorSdkWireError,
  type CursorSdkWireError,
} from "./CursorSdkErrors.ts";

interface CursorSdkWorkerMethods {
  readonly open: {
    readonly input: {
      readonly operation: "create" | "resume";
      readonly agentId?: string;
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly options: CursorSdkWireAgentOptions;
    };
    readonly output: { readonly agentId: string };
  };
  readonly send: {
    readonly input: {
      readonly sendId: number;
      readonly message: string | SDKUserMessage;
      readonly options?: CursorSdkWireSendOptions;
    };
    readonly output: { readonly runId: string; readonly agentId: string };
  };
  readonly cancel: { readonly input: { readonly sendId: number }; readonly output: void };
  readonly messages: { readonly input: undefined; readonly output: ReadonlyArray<AgentMessage> };
  readonly close: { readonly input: undefined; readonly output: void };
}

export type CursorSdkWorkerRequest = {
  [K in keyof CursorSdkWorkerMethods]: {
    readonly type: "request";
    readonly id: number;
    readonly method: K;
    readonly input: CursorSdkWorkerMethods[K]["input"];
  };
}[keyof CursorSdkWorkerMethods];

export type CursorSdkWorkerMessage =
  | CursorSdkWorkerRequest
  | { readonly type: "response"; readonly id: number; readonly value: unknown }
  | { readonly type: "failure"; readonly id: number; readonly error: CursorSdkWireError }
  | {
      readonly type: "callback";
      readonly id: number;
      readonly key: number;
      readonly input: unknown;
      readonly sendId?: number;
    }
  | {
      readonly type: "delta";
      readonly id: number;
      readonly sendId: number;
      readonly update: InteractionUpdate;
    }
  | { readonly type: "log"; readonly id: number; readonly event: CursorAgentSdkProtocolLogEvent }
  | {
      readonly type: "completed";
      readonly sendId: number;
      readonly result: Omit<RunResult, "error">;
      readonly error?: CursorSdkWireError;
    }
  | { readonly type: "runFailed"; readonly sendId: number; readonly error: CursorSdkWireError };

export interface CursorSdkIpcEndpoint {
  readonly send: (message: CursorSdkWorkerMessage, callback: (error: Error | null) => void) => void;
  readonly onMessage: (listener: (message: CursorSdkWorkerMessage) => void) => () => void;
  readonly onDisconnect: (listener: () => void) => () => void;
}

interface PendingReply {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

// Both the native write queue and unanswered callbacks have finite capacity; overflow fails the session.
const MAX_PENDING_MESSAGES = 256;
// The accepted 80 MiB of images become base64 before crossing this boundary.
const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;
const MAX_QUEUED_BYTES = 256 * 1024 * 1024;

export class CursorSdkTransport {
  private nextId = 0;
  private pending = new Map<number, PendingReply>();
  private queuedBytes = 0;
  private incoming = 0;
  private failure: Error | undefined;
  private readonly detach: ReadonlyArray<() => void>;
  private readonly endpoint: CursorSdkIpcEndpoint;
  private readonly handle: (
    message: Exclude<CursorSdkWorkerMessage, { readonly type: "response" | "failure" }>,
  ) => Promise<unknown>;
  private readonly onFailure: (error: Error) => void;
  private readonly encodeError: typeof cursorSdkWireError;

  constructor(
    endpoint: CursorSdkIpcEndpoint,
    handle: (
      message: Exclude<CursorSdkWorkerMessage, { readonly type: "response" | "failure" }>,
    ) => Promise<unknown>,
    onFailure: (error: Error) => void,
    encodeError = cursorSdkWireError,
  ) {
    this.endpoint = endpoint;
    this.handle = handle;
    this.onFailure = onFailure;
    this.encodeError = encodeError;
    this.detach = [
      endpoint.onMessage((message) => this.receive(message)),
      endpoint.onDisconnect(() => this.fail(new Error("Cursor SDK worker IPC disconnected."))),
    ];
  }

  request<K extends keyof CursorSdkWorkerMethods>(
    method: K,
    input: CursorSdkWorkerMethods[K]["input"],
  ): Promise<CursorSdkWorkerMethods[K]["output"]> {
    return this.reply({
      type: "request",
      id: ++this.nextId,
      method,
      input,
    } as CursorSdkWorkerRequest) as Promise<CursorSdkWorkerMethods[K]["output"]>;
  }

  callback(key: number, input: unknown, sendId?: number): Promise<unknown> {
    return this.reply({
      type: "callback",
      id: ++this.nextId,
      key,
      input,
      ...(sendId === undefined ? {} : { sendId }),
    });
  }

  delta(sendId: number, update: InteractionUpdate): Promise<void> {
    return this.reply({ type: "delta", id: ++this.nextId, sendId, update }) as Promise<void>;
  }

  log(event: CursorAgentSdkProtocolLogEvent): Promise<void> {
    return this.reply({ type: "log", id: ++this.nextId, event }) as Promise<void>;
  }

  private reply(message: CursorSdkWorkerMessage & { readonly id: number }): Promise<unknown> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.pending.size >= MAX_PENDING_MESSAGES) {
      this.fail(new Error("Cursor SDK worker exceeded the pending IPC limit."));
      return Promise.reject(this.failure);
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      this.send(message).catch((error: unknown) => this.fail(error));
    });
  }

  send(message: CursorSdkWorkerMessage): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      try {
        const size = NodeV8.serialize(message).byteLength;
        if (size > MAX_MESSAGE_BYTES || this.queuedBytes + size > MAX_QUEUED_BYTES) {
          throw new Error("Cursor SDK worker exceeded the IPC byte limit.");
        }
        this.queuedBytes += size;
        this.endpoint.send(message, (error) => {
          this.queuedBytes -= size;
          if (error !== null) {
            this.fail(error);
            reject(error);
          } else {
            resolve();
          }
        });
      } catch (error) {
        this.fail(error);
        reject(error);
      }
    });
  }

  private receive(message: CursorSdkWorkerMessage): void {
    if (this.failure !== undefined) return;
    if (message.type === "response" || message.type === "failure") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      if (message.type === "failure") pending.reject(new CursorSdkRemoteError(message.error));
      else pending.resolve(message.value);
      return;
    }
    if (++this.incoming > MAX_PENDING_MESSAGES) {
      this.fail(new Error("Cursor SDK worker exceeded the incoming IPC limit."));
      return;
    }
    // Operations run independently so a blocked send/callback cannot block cancel or close.
    void Promise.resolve()
      .then(() => this.handle(message))
      .then(
        (value) =>
          "id" in message ? this.send({ type: "response", id: message.id, value }) : undefined,
        (error: unknown) =>
          "id" in message
            ? this.send({ type: "failure", id: message.id, error: this.encodeError(error) })
            : this.fail(error),
      )
      .catch((error: unknown) => this.fail(error))
      .finally(() => {
        this.incoming -= 1;
      });
  }

  fail(cause: unknown): void {
    if (this.failure !== undefined) return;
    this.failure = cause instanceof Error ? cause : new Error(String(cause));
    for (const detach of this.detach) detach();
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.onFailure(this.failure);
  }
}

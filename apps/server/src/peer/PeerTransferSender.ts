// @effect-diagnostics nodeBuiltinImport:off - File handles support bounded positional binary reads and incremental SHA-256.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { type EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PeerMcpClient from "./PeerMcpClient.ts";

const MAX_BYTES = 50 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

const TransferStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("receiving"), offset: Schema.Number }),
  Schema.Struct({
    state: Schema.Literal("finished"),
    path: Schema.String,
    sizeBytes: Schema.Number,
    sha256: Schema.String,
  }),
  Schema.Struct({ state: Schema.Literal("aborted") }),
  Schema.Struct({ state: Schema.Literal("interrupted") }),
  Schema.Struct({ state: Schema.Literal("released") }),
  Schema.Struct({ state: Schema.Literal("not_found") }),
]);
type TransferStatus = typeof TransferStatus.Type;

export class PeerTransferSenderError extends Schema.TaggedError<PeerTransferSenderError>()(
  "PeerTransferSenderError",
  {
    reason: Schema.Literals([
      "invalid",
      "source",
      "limit",
      "denied",
      "peer",
      "unknown",
      "integrity",
      "aborted",
      "interrupted",
      "released",
      "quota",
      "wrong_target",
      "conflict",
      "busy",
      "platform_unsupported",
      "expired",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid":
        return "The transfer request is invalid.";
      case "source":
        return "The authorized source file could not be read.";
      case "limit":
        return "The file exceeds the 50 MiB transfer limit.";
      case "denied":
        return "The linked environment refused this transfer.";
      case "peer":
        return "The linked environment could not complete the transfer.";
      case "unknown":
        return "The transfer outcome is unknown. Retry with the same request ID.";
      case "integrity":
        return "The transferred data failed its integrity check.";
      case "aborted":
        return "This transfer was aborted. Use a new request ID for a new transfer.";
      case "interrupted":
        return "This transfer was interrupted on the destination. Abort it before starting a new transfer.";
      case "released":
        return "This transfer was released. Use a new request ID for a new transfer.";
      case "quota":
        return "The destination's transfer staging limit is full.";
      case "wrong_target":
        return "The destination identity does not match this transfer.";
      case "conflict":
        return "This request ID conflicts with an existing transfer.";
      case "busy":
        return "The transfer is busy. Retry with the same request ID.";
      case "platform_unsupported":
        return "Private transfer staging is not supported on the destination platform.";
      case "expired":
        return "This transfer request has expired. Use a new request ID for a new transfer.";
    }
  }
}

export class PeerTransferSender extends Context.Service<
  PeerTransferSender,
  {
    readonly transfer: (input: {
      readonly sourcePath: string;
      readonly expected?: { readonly sizeBytes: number; readonly sha256: string };
      readonly target: EnvironmentId;
      readonly callerNamespace: string;
      readonly authorize: Effect.Effect<PeerMcpClient.PeerCallLimits, OrchestratorMcpFailure>;
      readonly clientRequestId: string;
    }) => Effect.Effect<
      { readonly path: string; readonly sizeBytes: number; readonly sha256: string },
      PeerTransferSenderError
    >;
    readonly status: (input: {
      readonly target: EnvironmentId;
      readonly callerNamespace: string;
      readonly authorize: Effect.Effect<PeerMcpClient.PeerCallLimits, OrchestratorMcpFailure>;
      readonly clientRequestId: string;
    }) => Effect.Effect<TransferStatus, PeerTransferSenderError>;
    readonly abort: (input: {
      readonly target: EnvironmentId;
      readonly callerNamespace: string;
      readonly authorize: Effect.Effect<PeerMcpClient.PeerCallLimits, OrchestratorMcpFailure>;
      readonly clientRequestId: string;
    }) => Effect.Effect<void, PeerTransferSenderError>;
    readonly release: (input: {
      readonly target: EnvironmentId;
      readonly callerNamespace: string;
      readonly authorize: Effect.Effect<PeerMcpClient.PeerCallLimits, OrchestratorMcpFailure>;
      readonly clientRequestId: string;
    }) => Effect.Effect<void, PeerTransferSenderError>;
  }
>()("t3/peer/PeerTransferSender") {}

const requestIdOf = (namespace: string, requestId: string) =>
  `${requestId.slice(0, 13)}-${NodeCrypto.createHash("sha256")
    .update(JSON.stringify([namespace, requestId]))
    .digest("hex")}`;

const fromPeerError = (error: OrchestratorMcpFailure) => {
  const known =
    /^Transfer failed: (wrong_target|limit|conflict|busy|integrity|interrupted|platform_unsupported|expired)\.$/.exec(
      error.message,
    )?.[1];
  const reason = known === "limit" ? "quota" : known;
  if (
    reason === "wrong_target" ||
    reason === "quota" ||
    reason === "conflict" ||
    reason === "busy" ||
    reason === "integrity" ||
    reason === "interrupted" ||
    reason === "platform_unsupported" ||
    reason === "expired"
  )
    return new PeerTransferSenderError({ reason });
  return new PeerTransferSenderError({
    reason:
      error.code === "capability_denied"
        ? "denied"
        : error.code === "orchestration_error"
          ? "unknown"
          : "peer",
  });
};

const make = Effect.gen(function* () {
  const peer = yield* PeerMcpClient.PeerMcpClient;

  const call = (
    input: {
      readonly target: EnvironmentId;
      readonly authorize: Effect.Effect<PeerMcpClient.PeerCallLimits, OrchestratorMcpFailure>;
      readonly requestId: string;
    },
    operation: string,
    extra: Record<string, unknown> = {},
  ) =>
    input.authorize.pipe(
      Effect.flatMap((limits) =>
        peer.call({
          environmentId: input.target,
          limits,
          tool: `t3_peer_transfer_${operation}`,
          arguments: { target: input.target, requestId: input.requestId, ...extra },
          success: TransferStatus,
        }),
      ),
    );

  const validate = (namespace: string, requestId: string) =>
    namespace.length > 0 &&
    namespace.length <= 1024 &&
    /^\d{13}-[A-Za-z0-9_-]{1,200}$/.test(requestId);

  const status: PeerTransferSender["Service"]["status"] = Effect.fn("PeerTransferSender.status")(
    function* (input) {
      if (!validate(input.callerNamespace, input.clientRequestId)) {
        return yield* new PeerTransferSenderError({ reason: "invalid" });
      }
      return yield* call(
        { ...input, requestId: requestIdOf(input.callerNamespace, input.clientRequestId) },
        "status",
      ).pipe(Effect.mapError(fromPeerError));
    },
  );

  const abort: PeerTransferSender["Service"]["abort"] = Effect.fn("PeerTransferSender.abort")(
    function* (input) {
      if (!validate(input.callerNamespace, input.clientRequestId)) {
        return yield* new PeerTransferSenderError({ reason: "invalid" });
      }
      const status = yield* call(
        { ...input, requestId: requestIdOf(input.callerNamespace, input.clientRequestId) },
        "abort",
      ).pipe(Effect.mapError(fromPeerError));
      if (status.state !== "aborted") return yield* new PeerTransferSenderError({ reason: "peer" });
    },
  );

  const release: PeerTransferSender["Service"]["release"] = Effect.fn("PeerTransferSender.release")(
    function* (input) {
      if (!validate(input.callerNamespace, input.clientRequestId)) {
        return yield* new PeerTransferSenderError({ reason: "invalid" });
      }
      const state = yield* call(
        { ...input, requestId: requestIdOf(input.callerNamespace, input.clientRequestId) },
        "release",
        { destinationUseComplete: true },
      ).pipe(Effect.mapError(fromPeerError));
      if (state.state !== "released")
        return yield* new PeerTransferSenderError({ reason: "unknown" });
    },
  );

  const transfer: PeerTransferSender["Service"]["transfer"] = Effect.fn(
    "PeerTransferSender.transfer",
  )(function* (input) {
    if (!validate(input.callerNamespace, input.clientRequestId)) {
      return yield* new PeerTransferSenderError({ reason: "invalid" });
    }
    const request = {
      ...input,
      requestId: requestIdOf(input.callerNamespace, input.clientRequestId),
    };
    const sourceError = () => new PeerTransferSenderError({ reason: "source" });
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          NodeFSP.open(
            input.sourcePath,
            NodeFS.constants.O_RDONLY |
              (NodeFS.constants.O_NONBLOCK ?? 0) |
              (NodeFS.constants.O_NOFOLLOW ?? 0),
          ),
        catch: sourceError,
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({ try: () => handle.stat(), catch: sourceError });
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            !Number.isSafeInteger(stat.size) ||
            stat.size < 0
          )
            return yield* sourceError();
          if (stat.size > MAX_BYTES) return yield* new PeerTransferSenderError({ reason: "limit" });
          const readAt = (offset: number, length: number) =>
            Effect.tryPromise({
              try: async () => {
                const bytes = Buffer.allocUnsafe(length);
                let read = 0;
                while (read < length) {
                  const part = await handle.read(bytes, read, length - read, offset + read);
                  if (part.bytesRead === 0) throw new Error("short read");
                  read += part.bytesRead;
                }
                return bytes;
              },
              catch: sourceError,
            });
          const checkSourceUnchanged = () =>
            Effect.tryPromise({ try: () => handle.stat(), catch: sourceError }).pipe(
              Effect.flatMap((current) =>
                current.isFile() &&
                current.size === stat.size &&
                current.mtimeMs === stat.mtimeMs &&
                current.ctimeMs === stat.ctimeMs
                  ? Effect.void
                  : Effect.fail(sourceError()),
              ),
            );
          const hash = NodeCrypto.createHash("sha256");
          for (let offset = 0; offset < stat.size; offset += CHUNK_BYTES) {
            hash.update(yield* readAt(offset, Math.min(CHUNK_BYTES, stat.size - offset)));
          }
          const sha256 = hash.digest("hex");
          if (
            input.expected !== undefined &&
            (input.expected.sizeBytes !== stat.size || input.expected.sha256 !== sha256)
          ) {
            return yield* new PeerTransferSenderError({ reason: "integrity" });
          }
          // An operation whose response was lost is resolved with the same request key.
          const invoke = (operation: string, extra: Record<string, unknown> = {}) =>
            call(request, operation, extra).pipe(
              Effect.catch((error: OrchestratorMcpFailure) =>
                error.code !== "orchestration_error"
                  ? Effect.fail(fromPeerError(error))
                  : call(request, "status").pipe(
                      Effect.mapError(() => new PeerTransferSenderError({ reason: "unknown" })),
                      Effect.filterOrElse(
                        () => operation !== "begin",
                        () =>
                          call(request, "begin", extra).pipe(
                            Effect.mapError(
                              () => new PeerTransferSenderError({ reason: "unknown" }),
                            ),
                          ),
                      ),
                    ),
              ),
            );
          let started = false;
          let finishing = false;
          const run = Effect.gen(function* () {
            let state = yield* invoke("begin", { sizeBytes: stat.size, sha256 });
            started = state.state === "receiving";
            for (;;) {
              if (state.state === "not_found")
                return yield* new PeerTransferSenderError({ reason: "unknown" });
              if (
                state.state === "aborted" ||
                state.state === "interrupted" ||
                state.state === "released"
              ) {
                return yield* new PeerTransferSenderError({ reason: state.state });
              }
              if (state.state === "finished") {
                yield* checkSourceUnchanged();
                if (
                  state.sizeBytes !== stat.size ||
                  state.sha256 !== sha256 ||
                  state.path.length === 0
                ) {
                  return yield* new PeerTransferSenderError({ reason: "integrity" });
                }
                return { path: state.path, sizeBytes: stat.size, sha256 };
              }
              const offset = state.offset;
              if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size) {
                return yield* new PeerTransferSenderError({ reason: "integrity" });
              }
              if (offset === stat.size) {
                yield* checkSourceUnchanged();
                finishing = true;
                state = yield* invoke("finish");
                finishing = false;
                if (state.state === "receiving")
                  return yield* new PeerTransferSenderError({ reason: "unknown" });
                continue;
              }
              const data = yield* readAt(offset, Math.min(CHUNK_BYTES, stat.size - offset));
              state = yield* invoke("append", { offset, base64: data.toString("base64") });
              if (state.state === "receiving" && state.offset !== offset + data.length) {
                // A lost response may mean the append did not commit; a later retry uses the same key.
                return yield* new PeerTransferSenderError({
                  reason: state.offset === offset ? "unknown" : "integrity",
                });
              }
            }
          });
          return yield* run.pipe(
            Effect.onInterrupt(() =>
              started && !finishing ? call(request, "abort").pipe(Effect.ignore) : Effect.void,
            ),
          );
        }),
      (handle) => Effect.promise(() => handle.close().catch(() => {})),
    );
  });
  return PeerTransferSender.of({ transfer, status, abort, release });
});

export const layer = Layer.effect(PeerTransferSender, make);

// @effect-diagnostics nodeBuiltinImport:off - Existing provisioned DPoP keys sign transport proofs; no key is generated or exported.
import * as NodeCrypto from "node:crypto";
import { computeDpopJwkThumbprint, DpopPublicJwk } from "@t3tools/shared/dpop";
import {
  ApprovalReviewError,
  ApprovalReviewForwardAck,
  ApprovalReviewOrderReceive,
  ApprovalReviewReceiverReadiness,
  ApprovalReviewHostOrder,
  ApprovalReviewResult,
  type ApprovalReviewSubmit,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readFleetConnections, publicConnection } from "../auth/fleet.ts";
import type { PairedVm, ForwardDestination } from "./ApprovalReviewOrderPolicy.ts";
import * as Policy from "./ApprovalReviewOrderPolicy.ts";

const encodeProofHeader = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      typ: Schema.Literal("dpop+jwt"),
      alg: Schema.Literal("ES256"),
      jwk: DpopPublicJwk,
    }),
  ),
);
const encodeProofPayload = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      htm: Schema.Literal("POST"),
      htu: Schema.String,
      iat: Schema.Number,
      jti: Schema.String,
      ath: Schema.String,
    }),
  ),
);

// Tests replace the HTTP boundary, never the authenticated receiver or host-order rules.
export class ApprovalReviewOrderHttp extends Context.Reference<typeof fetch>(
  "t3/ApprovalReviewOrderHttp",
  { defaultValue: () => fetch },
) {}
export class ApprovalReviewOrderForward extends Context.Service<
  ApprovalReviewOrderForward,
  {
    readonly ready: (channel: PairedVm, testOnly: boolean) => Effect.Effect<boolean>;
    readonly readOrder: (
      destination: ForwardDestination,
      testOnly: boolean,
      orderId: string,
    ) => Effect.Effect<ApprovalReviewHostOrder, ApprovalReviewError>;
    readonly propose: (
      destination: ForwardDestination,
      testOnly: boolean,
      input: ApprovalReviewSubmit,
    ) => Effect.Effect<typeof ApprovalReviewResult.Type, ApprovalReviewError>;
    readonly send: (
      channel: PairedVm,
      input: ApprovalReviewOrderReceive,
    ) => Effect.Effect<ApprovalReviewForwardAck, ApprovalReviewError>;
  }
>()("t3/orchestration-v2/ApprovalReviewOrderForward") {}

const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApprovalReviewReceiverReadinessJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewReceiverReadiness),
);
const decodeApprovalReviewForwardAckJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewForwardAck),
);
const decodeApprovalReviewHostOrderJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewHostOrder),
);
const decodeApprovalReviewResultJson = Schema.decodeEffect(
  Schema.fromJsonString(ApprovalReviewResult),
);

const make = Effect.gen(function* () {
  const policy = yield* Policy.ApprovalReviewOrderPolicy;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* ApprovalReviewOrderHttp;
  const load = Effect.fn("ApprovalReviewOrderForward.load")(function* (
    channel: ForwardDestination,
    testOnly: boolean,
  ) {
    let origin: string;
    const secretName = channel.forward.credentialSecretName;
    if (channel.forward.developmentHttpBaseUrl !== undefined) {
      if (!testOnly) return yield* new ApprovalReviewError({ reason: "channel-unconfigured" });
      const url = yield* Effect.try({
        try: () => new URL(channel.forward.developmentHttpBaseUrl!),
        catch: () => new ApprovalReviewError({ reason: "channel-unconfigured" }),
      });
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.pathname !== "/" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        return yield* new ApprovalReviewError({ reason: "channel-unconfigured" });
      origin = url.origin;
    } else {
      const fleet = yield* readFleetConnections.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, store),
        Effect.mapError(() => new ApprovalReviewError({ reason: "channel-unconfigured" })),
      );
      const entry = fleet.find((entry) => entry.environmentId === channel.environmentId);
      if (entry === undefined)
        return yield* new ApprovalReviewError({ reason: "channel-unconfigured" });
      const connection = yield* Effect.try({
        try: () => publicConnection(entry),
        catch: () => new ApprovalReviewError({ reason: "channel-unconfigured" }),
      });
      origin = connection.httpBaseUrl;
    }
    const token = yield* store
      .get(secretName)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "channel-unconfigured" })));
    const key = yield* store
      .get(channel.forward.proofKeySecretName)
      .pipe(Effect.mapError(() => new ApprovalReviewError({ reason: "channel-unconfigured" })));
    if (Option.isNone(token) || Option.isNone(key))
      return yield* new ApprovalReviewError({ reason: "channel-unconfigured" });
    return yield* Effect.try({
      try: () => {
        const privateKey = NodeCrypto.createPrivateKey(Buffer.from(key.value));
        const exported = NodeCrypto.createPublicKey(privateKey).export({ format: "jwk" });
        const credential = new TextDecoder().decode(token.value).trim();
        if (
          privateKey.asymmetricKeyType !== "ec" ||
          exported.crv !== "P-256" ||
          exported.kty !== "EC" ||
          typeof exported.x !== "string" ||
          typeof exported.y !== "string" ||
          !credential
        )
          throw new Error();
        const publicJwk = {
          kty: "EC" as const,
          crv: "P-256" as const,
          x: exported.x,
          y: exported.y,
        };
        return {
          origin,
          credential,
          privateKey,
          publicJwk,
          thumbprint: computeDpopJwkThumbprint(publicJwk),
        };
      },
      catch: () => new ApprovalReviewError({ reason: "channel-unconfigured" }),
    });
  });
  const request = Effect.fn("ApprovalReviewOrderForward.request")(function* (
    channel: ForwardDestination,
    testOnly: boolean,
    path: string,
    body: unknown,
  ) {
    const transport = yield* load(channel, testOnly);
    const url = new URL(path, transport.origin).href;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const header = yield* encodeProofHeader({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: transport.publicJwk,
    }).pipe(
      Effect.map((json) => Buffer.from(json).toString("base64url")),
      Effect.mapError(() => new ApprovalReviewError({ reason: "channel-unconfigured" })),
    );
    const payload = yield* Effect.try({
      try: () => ({
        htm: "POST" as const,
        htu: url,
        iat: Math.floor(now / 1_000),
        jti: NodeCrypto.randomUUID(),
        ath: NodeCrypto.createHash("sha256").update(transport.credential).digest("base64url"),
      }),
      catch: () => new ApprovalReviewError({ reason: "channel-unconfigured" }),
    }).pipe(
      Effect.flatMap(encodeProofPayload),
      Effect.map((json) => Buffer.from(json).toString("base64url")),
      Effect.mapError(() => new ApprovalReviewError({ reason: "channel-unconfigured" })),
    );
    const proof = yield* Effect.try({
      try: () => {
        const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
          key: transport.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return `${header}.${payload}.${signature}`;
      },
      catch: () => new ApprovalReviewError({ reason: "channel-unconfigured" }),
    });
    const bodyJson = yield* encodeUnknownJson(body).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "forward-unknown" })),
    );
    const response = yield* Effect.tryPromise({
      try: () =>
        http(url, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(8_000),
          headers: {
            Authorization: `DPoP ${transport.credential}`,
            DPoP: proof,
            "Content-Type": "application/json",
          },
          body: bodyJson,
        }),
      catch: () => new ApprovalReviewError({ reason: "forward-unknown" }),
    });
    if (!response.ok) return yield* new ApprovalReviewError({ reason: "forward-unknown" });
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new ApprovalReviewError({ reason: "forward-unknown" }),
    });
    if (text.length > 1_572_864)
      return yield* new ApprovalReviewError({ reason: "forward-unknown" });
    return text;
  });
  const ready = Effect.fn("ApprovalReviewOrderForward.ready")(function* (
    channel: PairedVm,
    testOnly: boolean,
  ) {
    if (!policy.enabled) return false;
    return yield* Effect.gen(function* () {
      const transport = yield* load(channel, testOnly);
      const text = yield* request(
        channel,
        testOnly,
        "/api/approval-review/orders/receiver-readiness",
        { targetThreadId: channel.threadId, testOnly },
      );
      const identity = yield* decodeApprovalReviewReceiverReadinessJson(text);
      return (
        identity.ready &&
        identity.sessionId === channel.forward.sessionId &&
        identity.subject === channel.forward.subject &&
        identity.method === "dpop-access-token" &&
        identity.proofKeyThumbprint === transport.thumbprint &&
        identity.environmentId === channel.environmentId &&
        identity.threadId === channel.threadId &&
        identity.testOnly === testOnly
      );
    }).pipe(Effect.orElseSucceed(() => false));
  });
  const send = Effect.fn("ApprovalReviewOrderForward.send")(function* (
    channel: PairedVm,
    input: ApprovalReviewOrderReceive,
  ) {
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    const text = yield* request(
      channel,
      input.testOnly,
      "/api/approval-review/orders/receive",
      input,
    );
    return yield* decodeApprovalReviewForwardAckJson(text, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "forward-unknown" })),
    );
  });
  const readOrder = Effect.fn("ApprovalReviewOrderForward.readOrder")(function* (
    destination: ForwardDestination,
    testOnly: boolean,
    orderId: string,
  ) {
    const text = yield* request(destination, testOnly, "/api/approval-review/orders/read", {
      orderId,
    });
    return yield* decodeApprovalReviewHostOrderJson(text).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "forward-unknown" })),
    );
  });
  const propose = Effect.fn("ApprovalReviewOrderForward.propose")(function* (
    destination: ForwardDestination,
    testOnly: boolean,
    input: ApprovalReviewSubmit,
  ) {
    if (!policy.enabled) return yield* new ApprovalReviewError({ reason: "disabled" });
    const text = yield* request(destination, testOnly, "/api/approval-review/submit", input);
    return yield* decodeApprovalReviewResultJson(text).pipe(
      Effect.mapError(() => new ApprovalReviewError({ reason: "forward-unknown" })),
    );
  });
  return ApprovalReviewOrderForward.of({ ready, send, readOrder, propose });
});
export const layer = Layer.effect(ApprovalReviewOrderForward, make);

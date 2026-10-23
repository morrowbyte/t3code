// @effect-diagnostics nodeBuiltinImport:off - Ephemeral test-only DPoP keys never provision an application profile.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  MessageId,
  ThreadId,
  type ApprovalReviewOrderReceive,
} from "@t3tools/contracts";
import {
  computeDpopJwkThumbprint,
  verifyDpopProof,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Forward from "./ApprovalReviewOrderForward.ts";
import type { PairedVm } from "./ApprovalReviewOrderPolicy.ts";
import { hash, forwardedOrderText } from "./ApprovalReviewPackage.ts";

it.effect(
  "forwards through existing private-store DPoP credentials and binds instruction plus original",
  () =>
    Effect.gen(function* () {
      const key = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicJwk = key.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const credential = "ephemeral-unit-test-credential";
      const threadId = ThreadId.make("receiver-thread");
      const channel: PairedVm = {
        hostThreadId: ThreadId.make("host-control"),
        vmId: "vm",
        label: "VM",
        environmentId: EnvironmentId.make("vm-environment"),
        threadId,
        sessionId: AuthSessionId.make("paired-vm"),
        subject: "vm",
        proofKeyThumbprint: "v".repeat(43),
        forward: {
          developmentHttpBaseUrl: "http://127.0.0.1:12345/",
          credentialSecretName: "test-token",
          sessionId: AuthSessionId.make("host-to-vm-session"),
          subject: "host-forward",
          proofKeySecretName: "test-key",
        },
      };
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const input: ApprovalReviewOrderReceive = {
        testOnly: true,
        orderId: "order:test",
        orderRevision: 1,
        text: "Exact original\r\n😀",
        fullTextHash: hash("Exact original\r\n😀"),
        expiresAt: now + 60_000,
        targetThreadId: threadId,
        commandId: "host-order:order:test:forward:1",
        messageId: MessageId.make("host-order:order:test:vm-message"),
      };
      let calls = 0;
      let storedCredential = credential;
      let storedKey = key.privateKey;
      let receiverSessionId = channel.forward.sessionId;
      let receiverEnvironmentId = channel.environmentId;
      let receiverReady = true;
      const http: typeof fetch = async (url, init) => {
        calls++;
        const headers = new Headers(init?.headers);
        if (headers.get("authorization") !== `DPoP ${credential}`)
          return new Response(null, { status: 401 });
        const proof = verifyDpopProof({
          proof: headers.get("dpop") ?? undefined,
          method: "POST",
          url: String(url),
          nowEpochSeconds: Math.floor(now / 1_000),
          expectedThumbprint: computeDpopJwkThumbprint(publicJwk),
          expectedAccessToken: credential,
        });
        if (!proof.ok) return new Response(null, { status: 401 });
        if (new URL(String(url)).pathname === "/api/approval-review/orders/receiver-readiness") {
          return Response.json({
            sessionId: receiverSessionId,
            subject: channel.forward.subject,
            method: "dpop-access-token",
            proofKeyThumbprint: computeDpopJwkThumbprint(publicJwk),
            environmentId: receiverEnvironmentId,
            threadId,
            testOnly: true,
            ready: receiverReady,
          });
        }
        assert.equal(new URL(String(url)).pathname, "/api/approval-review/orders/receive");
        assert.equal(init?.body, JSON.stringify(input));
        assert.equal(
          Buffer.from((headers.get("dpop") ?? "").split(".")[0]!, "base64url").toString("utf8"),
          JSON.stringify({
            typ: "dpop+jwt",
            alg: "ES256",
            jwk: {
              kty: publicJwk.kty,
              crv: publicJwk.crv,
              x: publicJwk.x,
              y: publicJwk.y,
            },
          }),
        );
        assert.deepEqual(JSON.parse(String(init?.body)), input);
        return Response.json({
          orderId: input.orderId,
          orderRevision: 1,
          commandId: input.commandId,
          fullTextHash: input.fullTextHash,
          instructionHash: hash(forwardedOrderText(input)),
          environmentId: channel.environmentId,
          threadId,
          messageId: input.messageId,
          runId: derive.run({ threadId, ordinal: 1 }),
          runOrdinal: 1,
          acceptedSequence: 1,
        });
      };
      const layer = Forward.layer.pipe(
        Layer.provide(Layer.succeed(Forward.ApprovalReviewOrderHttp, http)),
        Layer.provide(
          Layer.mock(Secrets.ServerSecretStore)({
            get: (name) =>
              Effect.succeed(
                name === "test-token"
                  ? Option.some(new TextEncoder().encode(storedCredential))
                  : name === "test-key"
                    ? Option.some(
                        new TextEncoder().encode(
                          storedKey.export({ format: "pem", type: "pkcs8" }).toString(),
                        ),
                      )
                    : Option.none(),
              ),
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* Forward.ApprovalReviewOrderForward;
        assert.isTrue(yield* service.ready(channel, true));
        const ack = yield* service.send(channel, input);
        assert.equal(ack.fullTextHash, input.fullTextHash);
        assert.equal(ack.instructionHash, hash(forwardedOrderText(input)));
        storedCredential = "unqualified-fleet-bearer";
        assert.isFalse(yield* service.ready(channel, true));
        storedCredential = credential;
        storedKey = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
        assert.isFalse(yield* service.ready(channel, true));
        storedKey = key.privateKey;
        receiverSessionId = AuthSessionId.make("foreign-authenticated-session");
        assert.isFalse(yield* service.ready(channel, true));
        receiverSessionId = channel.forward.sessionId;
        receiverEnvironmentId = EnvironmentId.make("foreign-environment");
        assert.isFalse(yield* service.ready(channel, true));
        receiverEnvironmentId = channel.environmentId;
        receiverReady = false;
        assert.isFalse(yield* service.ready(channel, true));
        assert.equal(
          (yield* service.send(channel, { ...input, testOnly: false }).pipe(Effect.flip)).reason,
          "channel-unconfigured",
        );
        assert.isFalse(
          yield* service.ready(
            {
              ...channel,
              forward: { ...channel.forward, developmentHttpBaseUrl: "http://localhost:12345/" },
            },
            true,
          ),
        );
        assert.equal(calls, 7);
      }).pipe(Effect.provide(layer));
    }),
);

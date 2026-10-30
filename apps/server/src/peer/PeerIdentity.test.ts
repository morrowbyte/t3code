import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { getPeerIdentity, verifyPeerIdentityProof } from "./PeerIdentity.ts";
import { makePeerIdentityChallenges } from "./PeerIdentityChallenge.ts";

const layerServerSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-identity-test-" })),
  );

it.layer(NodeServices.layer)("PeerIdentity", (it) => {
  it.effect("persists a separate key and verifies only the bound challenge", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const [first, concurrent] = yield* Effect.all(
        [getPeerIdentity(secrets), getPeerIdentity(secrets)],
        { concurrency: "unbounded" },
      );
      const again = yield* getPeerIdentity(secrets);
      assert.deepEqual(concurrent.publicKey, first.publicKey);
      assert.deepEqual(again.publicKey, first.publicKey);
      assert.isTrue(Option.isSome(yield* secrets.get("peer-identity-ed25519-seed-v1")));
      assert.isTrue(Option.isNone(yield* secrets.get("cloud-link-ed25519-key-pair")));

      const challenge = { nonce: new Uint8Array(32).fill(1), binding: new Uint8Array(32).fill(2) };
      const signature = first.sign(challenge);
      assert.isDefined(signature);
      if (signature === undefined) return;
      assert.isTrue(verifyPeerIdentityProof(again.publicKey, challenge, signature));
      assert.isFalse(
        verifyPeerIdentityProof(
          again.publicKey,
          { ...challenge, nonce: new Uint8Array(32) },
          signature,
        ),
      );
      assert.isFalse(
        verifyPeerIdentityProof(
          again.publicKey,
          { ...challenge, binding: new Uint8Array(32) },
          signature,
        ),
      );
      assert.isFalse(verifyPeerIdentityProof(new Uint8Array(32), challenge, signature));
      assert.isFalse(verifyPeerIdentityProof(again.publicKey, challenge, new Uint8Array(64)));
      assert.isFalse(verifyPeerIdentityProof(again.publicKey, challenge, new Uint8Array(1)));
      assert.isFalse(verifyPeerIdentityProof(new Uint8Array(1), challenge, signature));
      assert.isUndefined(first.sign({ ...challenge, nonce: new Uint8Array(31) }));
      assert.isFalse(
        verifyPeerIdentityProof(
          again.publicKey,
          { ...challenge, binding: new Uint8Array(31) },
          signature,
        ),
      );
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("fails closed on a corrupt stored seed instead of replacing the identity", () =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      yield* secrets.set("peer-identity-ed25519-seed-v1", new Uint8Array(31));
      const result = yield* Effect.flip(getPeerIdentity(secrets));
      assert.strictEqual(result._tag, "SecretStoreDecodeError");
      const stored = yield* secrets.get("peer-identity-ed25519-seed-v1");
      assert.isTrue(Option.isSome(stored) && stored.value.length === 31);
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("consumes challenges once against the current binding and operation", () =>
    Effect.gen(function* () {
      const identity = yield* getPeerIdentity(yield* ServerSecretStore.ServerSecretStore);
      let time = 1_000;
      const challenges = makePeerIdentityChallenges(() => time);
      const binding = {
        generation: "link-generation-1",
        verifierKey: new Uint8Array(32).fill(7),
        claimantKey: identity.publicKey,
        channelBinding: new Uint8Array(32).fill(8),
      };
      const issue = () => {
        const challenge = challenges.issue(binding, "transfer-read");
        assert.isDefined(challenge);
        if (challenge === undefined) throw new Error("challenge missing");
        const signature = identity.sign(challenge);
        assert.isDefined(signature);
        if (signature === undefined) throw new Error("signature missing");
        return { challenge, signature };
      };

      const valid = issue();
      assert.isTrue(
        challenges.consume(valid.challenge.nonce, valid.signature, binding, "transfer-read"),
      );
      assert.isFalse(
        challenges.consume(valid.challenge.nonce, valid.signature, binding, "transfer-read"),
      );

      const revoked = issue();
      assert.isFalse(
        challenges.consume(revoked.challenge.nonce, revoked.signature, undefined, "transfer-read"),
      );
      assert.isFalse(
        challenges.consume(revoked.challenge.nonce, revoked.signature, binding, "transfer-read"),
      );

      const relinked = issue();
      assert.isFalse(
        challenges.consume(
          relinked.challenge.nonce,
          relinked.signature,
          { ...binding, generation: "link-generation-2" },
          "transfer-read",
        ),
      );

      const reversed = issue();
      assert.isFalse(
        challenges.consume(
          reversed.challenge.nonce,
          reversed.signature,
          { ...binding, verifierKey: binding.claimantKey, claimantKey: binding.verifierKey },
          "transfer-read",
        ),
      );

      const operation = issue();
      assert.isFalse(
        challenges.consume(
          operation.challenge.nonce,
          operation.signature,
          binding,
          "transfer-write",
        ),
      );

      const channel = issue();
      assert.isFalse(
        challenges.consume(
          channel.challenge.nonce,
          channel.signature,
          { ...binding, channelBinding: new Uint8Array(32).fill(9) },
          "transfer-read",
        ),
      );

      const tampered = issue();
      assert.isFalse(
        challenges.consume(tampered.challenge.nonce, new Uint8Array(64), binding, "transfer-read"),
      );
      assert.isFalse(
        challenges.consume(tampered.challenge.nonce, tampered.signature, binding, "transfer-read"),
      );

      const expired = issue();
      time += 60_000;
      assert.isFalse(
        challenges.consume(expired.challenge.nonce, expired.signature, binding, "transfer-read"),
      );
      const restarted = issue();
      assert.isFalse(
        makePeerIdentityChallenges(() => time).consume(
          restarted.challenge.nonce,
          restarted.signature,
          binding,
          "transfer-read",
        ),
      );
      assert.isUndefined(challenges.issue({ ...binding, generation: "" }, "transfer-read"));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );
});

// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto does not provide Ed25519 signing.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const SECRET_NAME = "peer-identity-ed25519-seed-v1";
const PRIVATE_KEY_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DOMAIN = Buffer.from("t3code-peer-identity-proof-v1\0", "utf8");

// The verifier must create and atomically consume a fresh challenge, bind the
// digest to the current connection and operation, and check current access.
export interface PeerIdentityChallenge {
  readonly nonce: Uint8Array;
  readonly binding: Uint8Array;
}

const proofMessage = ({ nonce, binding }: PeerIdentityChallenge): Buffer | undefined =>
  nonce.length === 32 && binding.length === 32
    ? Buffer.concat([DOMAIN, nonce, binding])
    : undefined;

export const getPeerIdentity = Effect.fn("PeerIdentity.get")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  // A distinct key prevents peer proofs from being used as cloud-link proofs.
  const seed = yield* secrets.getOrCreateRandom(SECRET_NAME, 32);
  if (seed.length !== 32) {
    return yield* new ServerSecretStore.SecretStoreDecodeError({
      resource: "peer identity signing key",
      cause: new Error("Invalid peer identity seed length"),
    });
  }
  const privateKey = NodeCrypto.createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const encodedPublicKey = NodeCrypto.createPublicKey(privateKey).export({
    format: "der",
    type: "spki",
  });
  const publicKey = Uint8Array.from(encodedPublicKey.subarray(PUBLIC_KEY_PREFIX.length));
  return {
    publicKey,
    sign: (challenge: PeerIdentityChallenge): Uint8Array | undefined => {
      const message = proofMessage(challenge);
      return message === undefined ? undefined : NodeCrypto.sign(null, message, privateKey);
    },
  };
});

// This verifies possession only; it does not authenticate an unconfirmed key.
export const verifyPeerIdentityProof = (
  publicKey: Uint8Array,
  challenge: PeerIdentityChallenge,
  signature: Uint8Array,
): boolean => {
  const message = proofMessage(challenge);
  if (publicKey.length !== 32 || signature.length !== 64 || message === undefined) return false;
  try {
    return NodeCrypto.verify(
      null,
      message,
      NodeCrypto.createPublicKey({
        key: Buffer.concat([PUBLIC_KEY_PREFIX, publicKey]),
        format: "der",
        type: "spki",
      }),
      signature,
    );
  } catch {
    return false;
  }
};

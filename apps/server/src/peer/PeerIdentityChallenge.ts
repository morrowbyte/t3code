// @effect-diagnostics-next-line nodeBuiltinImport:off -- Ed25519 proofs use Node's crypto API.
import * as NodeCrypto from "node:crypto";

import { verifyPeerIdentityProof, type PeerIdentityChallenge } from "./PeerIdentity.ts";

/** A link generation must change on every unlink or relink; it is not an environment ID. */
export interface ConfirmedPeerBinding {
  readonly generation: string;
  readonly verifierKey: Uint8Array;
  readonly claimantKey: Uint8Array;
  /** Derived from the authenticated channel, never from a peer's assertion. */
  readonly channelBinding: Uint8Array;
}

interface PendingChallenge {
  readonly challenge: PeerIdentityChallenge;
  readonly expiresAt: number;
}

const bindingDigest = (
  binding: ConfirmedPeerBinding,
  operation: string,
): Uint8Array | undefined => {
  if (
    binding.verifierKey.length !== 32 ||
    binding.claimantKey.length !== 32 ||
    binding.channelBinding.length !== 32 ||
    binding.generation.length === 0 ||
    binding.generation.length > 256 ||
    operation.length === 0 ||
    operation.length > 256
  )
    return undefined;
  return NodeCrypto.createHash("sha256")
    .update("t3code-peer-binding-v1\0")
    .update(JSON.stringify([binding.generation, operation]))
    .update(binding.verifierKey)
    .update(binding.claimantKey)
    .update(binding.channelBinding)
    .digest();
};

/** Process-local challenges die on restart; they never establish or authorize a link. */
export const makePeerIdentityChallenges = (now: () => number = () => performance.now()) => {
  const pending = new Map<string, PendingChallenge>();
  const ttlMs = 60_000;
  const capacity = 1024;

  return {
    issue(binding: ConfirmedPeerBinding, operation: string): PeerIdentityChallenge | undefined {
      const digest = bindingDigest(binding, operation);
      if (digest === undefined) return undefined;
      const time = now();
      for (const [nonce, entry] of pending) {
        if (entry.expiresAt <= time) pending.delete(nonce);
      }
      if (pending.size >= capacity) return undefined;
      const nonce = NodeCrypto.randomBytes(32);
      const key = nonce.toString("base64url");
      if (pending.has(key)) return undefined;
      const challenge = { nonce, binding: digest };
      pending.set(key, {
        challenge: { nonce: Uint8Array.from(nonce), binding: Uint8Array.from(digest) },
        expiresAt: time + ttlMs,
      });
      return challenge;
    },

    /** The caller must obtain the current confirmed binding and independently check current rights. */
    consume(
      nonce: Uint8Array,
      signature: Uint8Array,
      current: ConfirmedPeerBinding | undefined,
      operation: string,
    ): boolean {
      if (nonce.length !== 32) return false;
      const key = Buffer.from(nonce).toString("base64url");
      const entry = pending.get(key);
      pending.delete(key);
      if (entry === undefined || entry.expiresAt <= now() || current === undefined) return false;
      const digest = bindingDigest(current, operation);
      return (
        digest !== undefined &&
        NodeCrypto.timingSafeEqual(entry.challenge.binding, digest) &&
        verifyPeerIdentityProof(current.claimantKey, entry.challenge, signature)
      );
    },
  };
};

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The lease starts on the target before the source takes its thread lock. */
const ADMISSION_LIFETIME_MS = 10_000;
export class ConnectedEnvironmentAdmission extends Context.Service<
  ConnectedEnvironmentAdmission,
  {
    readonly create: (sessionId: string) => Effect.Effect<string>;
    readonly consume: (
      sessionId: string,
      id: string,
    ) => Effect.Effect<number, OrchestratorMcpFailure>;
  }
>()("t3/mcp/connectedEnvironment/Admission/ConnectedEnvironmentAdmission") {}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.SecureRandom;
  const leases = new Map<string, { sessionId: string; expiresAt: number }>();
  const create = Effect.fn("ConnectedEnvironmentAdmission.create")(function* (sessionId: string) {
    const now = performance.now();
    for (const [id, lease] of leases) if (lease.expiresAt <= now) leases.delete(id);
    const id = yield* crypto.uuidV4().pipe(Effect.orDie);
    leases.set(id, { sessionId, expiresAt: now + ADMISSION_LIFETIME_MS });
    return id;
  });
  const consume = Effect.fn("ConnectedEnvironmentAdmission.consume")(function* (
    sessionId: string,
    id: string,
  ) {
    const lease = leases.get(id);
    if (!lease || lease.sessionId !== sessionId || lease.expiresAt <= performance.now()) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: "The connected environment admission expired or does not belong to this session.",
      });
    }
    leases.delete(id);
    return lease.expiresAt;
  });
  return ConnectedEnvironmentAdmission.of({ create, consume });
});
export const layer = Layer.effect(ConnectedEnvironmentAdmission, make);

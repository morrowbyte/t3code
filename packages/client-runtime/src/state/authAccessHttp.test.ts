import { describe, expect, it } from "@effect/vitest";
import { AuthAccessWriteScope, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import {
  createEnvironmentPairingCredential,
  revokeEnvironmentPairingLink,
  revokeEnvironmentClient,
  revokeOtherEnvironmentClients,
} from "./authAccessHttp.ts";

function harness(origin: string, token: string, respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const target = new RelayConnectionTarget({
    environmentId: EnvironmentId.make(origin),
    label: origin,
  });
  const prepared: PreparedConnection = {
    environmentId: target.environmentId,
    label: target.label,
    httpBaseUrl: origin,
    socketUrl: origin.replace("https:", "wss:") + "/ws",
    httpAuthorization: { _tag: "Bearer", token },
    target,
  };
  const fetchFn: typeof fetch = async (request, init) => {
    calls.push({ url: String(request), init: init ?? {} });
    return respond();
  };
  return {
    calls,
    input: { prepared, signer: Option.none() },
    layer: layerRemoteHttpClient(fetchFn),
  };
}
const pairingResponse = () =>
  Response.json({
    id: "pairing-1",
    credential: "one-time-test-credential",
    expiresAt: "2026-10-27T00:00:00.000Z",
  });

describe("environment access management", () => {
  it.effect("allows an empty optional label when creating a pairing link", () =>
    Effect.gen(function* () {
      const h = harness("https://laptop.example.test", "test-token", pairingResponse);
      yield* createEnvironmentPairingCredential(h.input, {
        label: "  ",
        scopes: [AuthAccessWriteScope],
      }).pipe(Effect.provide(h.layer));
      expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ scopes: [AuthAccessWriteScope] });
    }),
  );

  it.effect("creates on the selected environment with its credential and requested scopes", () =>
    Effect.gen(function* () {
      const first = harness("https://laptop.example.test", "laptop-test-token", pairingResponse);
      const second = harness("https://other.example.test", "other-test-token", pairingResponse);
      const input = { label: "Build host", scopes: [AuthAccessWriteScope] };
      const result = yield* createEnvironmentPairingCredential(first.input, input).pipe(
        Effect.provide(first.layer),
      );
      yield* createEnvironmentPairingCredential(second.input, input).pipe(
        Effect.provide(second.layer),
      );
      expect(result.id).toBe("pairing-1");
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(1);
      expect(first.calls[0]?.url).toBe("https://laptop.example.test/api/auth/pairing-token");
      expect(second.calls[0]?.url).toBe("https://other.example.test/api/auth/pairing-token");
      expect(new Headers(first.calls[0]?.init.headers).get("authorization")).toBe(
        "Bearer laptop-test-token",
      );
      expect(new Headers(second.calls[0]?.init.headers).get("authorization")).toBe(
        "Bearer other-test-token",
      );
      expect(JSON.parse(String(first.calls[0]?.init.body))).toEqual(input);
    }),
  );

  it.effect("returns a denied request without issuing another credential request", () =>
    Effect.gen(function* () {
      const h = harness("https://laptop.example.test", "limited-test-token", () =>
        Response.json(
          {
            _tag: "EnvironmentAuthInvalidError",
            code: "auth_invalid",
            reason: "invalid_credential",
            traceId: "trace-test",
          },
          { status: 401 },
        ),
      );
      const result = yield* createEnvironmentPairingCredential(h.input, {}).pipe(
        Effect.provide(h.layer),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
      expect(h.calls).toHaveLength(1);
    }),
  );

  it.effect("revokes the requested pairing link on the selected environment", () =>
    Effect.gen(function* () {
      const h = harness("https://laptop.example.test", "test-token", () =>
        Response.json({ revoked: true }),
      );
      yield* revokeEnvironmentPairingLink(h.input, "pairing-7").pipe(Effect.provide(h.layer));
      expect(h.calls[0]?.url).toBe("https://laptop.example.test/api/auth/pairing-links/revoke");
      expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ id: "pairing-7" });
    }),
  );

  it.effect("revokes clients through the same environment authorization", () =>
    Effect.gen(function* () {
      let others = false;
      const h = harness("https://laptop.example.test", "test-token", () =>
        Response.json(others ? { revokedCount: 2 } : { revoked: true }),
      );
      yield* revokeEnvironmentClient(h.input, AuthSessionId.make("client-3")).pipe(
        Effect.provide(h.layer),
      );
      others = true;
      const result = yield* revokeOtherEnvironmentClients(h.input).pipe(Effect.provide(h.layer));
      expect(h.calls.map((call) => call.url)).toEqual([
        "https://laptop.example.test/api/auth/clients/revoke",
        "https://laptop.example.test/api/auth/clients/revoke-others",
      ]);
      expect(JSON.parse(String(h.calls[0]?.init.body))).toEqual({ sessionId: "client-3" });
      expect(result.revokedCount).toBe(2);
    }),
  );
});

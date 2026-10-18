import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { makeCodexNativeAuth } from "./CodexNativeAuth.ts";

const frame = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
});
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.effect.each(["success", "early", "api-key", "cancel", "failed"] as const)(
  "owns native Codex login and verifies the matching account (%s)",
  (scenario) =>
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<Uint8Array>();
      const cancelled = yield* Deferred.make<string>();
      const allowVerification = yield* Deferred.make<void>();
      const requests: Array<{ method: string; params?: unknown }> = [];
      const send = (value: unknown) =>
        encode(value).pipe(
          Effect.flatMap((json) => Queue.offer(input, new TextEncoder().encode(`${json}\n`))),
        );
      const notification = (loginId: string, success = true) =>
        send({ method: "account/login/completed", params: { loginId, success } });
      const client = yield* CodexClient.make(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stderr: () => Sink.drain,
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                const request = yield* Schema.decodeEffect(Schema.fromJsonString(frame))(
                  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                );
                requests.push(request);
                if (request.method === "account/login/start") {
                  if (scenario === "early") yield* notification("owned-login");
                  yield* send({
                    id: request.id,
                    result: {
                      type: "chatgpt",
                      loginId: "owned-login",
                      authUrl: "https://auth.openai.com/authorize?state=synthetic-only",
                    },
                  });
                } else if (request.method === "account/read") {
                  yield* Deferred.await(allowVerification);
                  yield* send({
                    id: request.id,
                    result: {
                      requiresOpenaiAuth: true,
                      account:
                        scenario === "api-key"
                          ? { type: "apiKey" }
                          : { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
                    },
                  });
                } else {
                  yield* send({
                    id: request.id,
                    result: request.method === "account/login/cancel" ? { status: "canceled" } : {},
                  });
                  if (request.method === "account/login/cancel")
                    yield* Deferred.succeed(cancelled, "owned-login");
                }
              }).pipe(Effect.orDie),
            ),
        }),
      );
      const auth = yield* makeCodexNativeAuth({
        instanceId: ProviderInstanceId.make("codex"),
        homePath: "isolated-native-home",
        connect: Effect.succeed({ client }),
      });
      yield* auth.start("owner", Effect.void, "chatgpt");
      const waiting = yield* auth.subscribe("owner").pipe(
        Stream.filter((state) => state.phase === "waiting" || state.phase === "verifying"),
        Stream.take(1),
        Stream.runCollect,
      );
      assert.equal(waiting[0]?.interaction?.type, "browser");
      assert.deepEqual(requests[0]?.params, { type: "chatgpt" });
      assert.equal(auth.credentialBinding?.owner, "provider");
      if (scenario === "cancel") {
        const flowId = waiting[0]?.flowId;
        if (!flowId) throw new Error("Expected an owned login flow");
        yield* auth.cancel("owner", flowId);
        assert.equal(yield* Deferred.await(cancelled), "owned-login");
      } else {
        yield* Deferred.succeed(allowVerification, undefined);
        if (scenario !== "early") {
          const foreignObserved = yield* Deferred.make<void>();
          yield* client.handleServerNotification("account/login/completed", (value) =>
            value.loginId === "foreign-login"
              ? Deferred.succeed(foreignObserved, undefined).pipe(Effect.asVoid)
              : Effect.void,
          );
          yield* notification("foreign-login");
          yield* Deferred.await(foreignObserved);
          assert.isFalse(requests.some((request) => request.method === "account/read"));
          yield* notification("owned-login", scenario !== "failed");
        }
        const terminal = yield* auth.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "succeeded" || state.phase === "failed"),
          Stream.take(1),
          Stream.runCollect,
        );
        assert.equal(
          terminal[0]?.phase,
          ["success", "early"].includes(scenario) ? "succeeded" : "failed",
        );
      }
      assert.isFalse(requests.some((request) => request.method.startsWith("thread/")));
      assert.isFalse(requests.some((request) => request.method === "turn/start"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps simultaneous account logins isolated even when native login IDs coincide", () =>
  Effect.gen(function* () {
    const open = (instance: string) =>
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<Uint8Array>();
        const reads: string[] = [];
        const send = (value: unknown) =>
          encode(value).pipe(
            Effect.flatMap((json) => Queue.offer(incoming, new TextEncoder().encode(`${json}\n`))),
          );
        const client = yield* CodexClient.make(
          Stdio.make({
            args: Effect.succeed([]),
            stdin: Stream.fromQueue(incoming),
            stderr: () => Sink.drain,
            stdout: () =>
              Sink.forEach((chunk: string | Uint8Array) =>
                Effect.gen(function* () {
                  const request = yield* Schema.decodeEffect(Schema.fromJsonString(frame))(
                    typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                  );
                  if (request.method === "account/read") reads.push(instance);
                  yield* send({
                    id: request.id,
                    result:
                      request.method === "account/login/start"
                        ? {
                            type: "chatgpt",
                            loginId: "same-native-id",
                            authUrl: "https://auth.openai.com/authorize",
                          }
                        : request.method === "account/read"
                          ? {
                              requiresOpenaiAuth: true,
                              account: {
                                type: "chatgpt",
                                email: `${instance}@example.test`,
                                planType: "plus",
                              },
                            }
                          : { status: "canceled" },
                  });
                }).pipe(Effect.orDie),
              ),
          }),
        );
        const auth = yield* makeCodexNativeAuth({
          instanceId: ProviderInstanceId.make(instance),
          homePath: `isolated/${instance}`,
          connect: Effect.succeed({ client }),
        });
        return {
          auth,
          reads,
          complete: send({
            method: "account/login/completed",
            params: { loginId: "same-native-id", success: true },
          }),
        };
      });
    const first = yield* open("personal");
    const second = yield* open("work");
    for (const fixture of [first, second]) {
      yield* fixture.auth.start("owner", Effect.void, "chatgpt");
      yield* fixture.auth.subscribe("owner").pipe(
        Stream.filter((s) => s.phase === "waiting"),
        Stream.take(1),
        Stream.runDrain,
      );
    }
    assert.notDeepEqual(first.auth.credentialBinding, second.auth.credentialBinding);
    yield* first.complete;
    yield* first.auth.subscribe("owner").pipe(
      Stream.filter((s) => s.phase === "succeeded"),
      Stream.take(1),
      Stream.runDrain,
    );
    assert.deepEqual(first.reads, ["personal"]);
    assert.deepEqual(second.reads, []);
    yield* second.complete;
    yield* second.auth.subscribe("owner").pipe(
      Stream.filter((s) => s.phase === "succeeded"),
      Stream.take(1),
      Stream.runDrain,
    );
    assert.deepEqual(second.reads, ["work"]);
    assert.deepEqual(first.reads, ["personal"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export const makeCodexNativeAuth = Effect.fn("makeCodexNativeAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly homePath: string;
  readonly connect: Effect.Effect<
    { readonly client: CodexClient.CodexAppServerClient["Service"] },
    ProviderSetupError,
    Scope.Scope
  >;
}) {
  const failure = (operation: string) => (_cause: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail: "Codex sign-in could not finish. Check the runtime and try again.",
    });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: options.homePath },
    defaultMethodId: "chatgpt",
    methods: Effect.succeed([
      { id: "chatgpt", name: "ChatGPT (Codex)", type: "agent", description: null },
    ]),
    authenticate: (_method, context) =>
      Effect.gen(function* () {
        const { client } = yield* options.connect;
        const completed = yield* Deferred.make<CodexSchema.V2AccountLoginCompletedNotification>();
        let loginId: string | undefined;
        const early = yield* Ref.make<CodexSchema.V2AccountLoginCompletedNotification | undefined>(
          undefined,
        );
        let verified = false;
        yield* client.handleServerNotification("account/login/completed", (notification) =>
          Effect.gen(function* () {
            if (loginId === undefined) {
              yield* Ref.set(early, notification);
            } else if (notification.loginId === loginId) {
              yield* Deferred.succeed(completed, notification);
            }
          }),
        );
        const login = yield* client.request("account/login/start", { type: "chatgpt" });
        if (login.type !== "chatgpt") return yield* failure("start")(undefined);
        loginId = login.loginId;
        // The native runtime owns credentials and its loopback callback. T3 only
        // holds the matching flow open; no tokens are imported or translated.
        yield* Effect.addFinalizer(() =>
          verified
            ? Effect.void
            : client
                .request("account/login/cancel", { loginId: login.loginId })
                .pipe(Effect.timeout("2 seconds"), Effect.ignore),
        );
        const url = yield* Effect.try({
          try: () => new URL(login.authUrl),
          catch: failure("start"),
        });
        if (url.protocol !== "https:" || url.username || url.password)
          return yield* failure("start")(undefined);
        const earlyResult = yield* Ref.get(early);
        if (earlyResult?.loginId === loginId) yield* Deferred.succeed(completed, earlyResult);
        yield* context.setInteraction({
          type: "browser",
          id: context.flowId,
          url: url.toString(),
          requiresConsent: false,
          acceptsCallback: false,
        });
        const result = yield* Deferred.await(completed);
        if (!result.success) return yield* failure("start")(undefined);
        yield* context.verifying;
        const account = yield* client.request("account/read", {});
        if (account.account?.type !== "chatgpt") return yield* failure("verify")(undefined);
        verified = true;
      }).pipe(Effect.mapError(failure("start"))),
    logout: Effect.gen(function* () {
      const { client } = yield* options.connect;
      yield* client.request("account/logout", undefined);
    }).pipe(Effect.scoped, Effect.mapError(failure("logout"))),
  });
});

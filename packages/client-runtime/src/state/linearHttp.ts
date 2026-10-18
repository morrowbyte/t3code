import type { LinearAction, LinearActionResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const requestEnvironmentLinear = (input: {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly action?: LinearAction;
}) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "linear",
    method: input.action ? "POST" : "GET",
    timeoutMs: 15_000,
    url: (urls) => (input.action ? urls.linearAction() : urls.linearSettings()),
    request: ({ client, headers }) =>
      input.action
        ? client.linearAction({ payload: { action: input.action }, headers })
        : client
            .linearSettings({ headers })
            .pipe(Effect.map((settings): typeof LinearActionResult.Type => ({ settings }))),
  });

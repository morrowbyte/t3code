import type { AuthGrantScope, AuthSessionId } from "@t3tools/contracts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import type { fetchEnvironmentSessionState } from "./session.ts";

export type AuthAccessHttpContext = Parameters<typeof fetchEnvironmentSessionState>[0];

export const createEnvironmentPairingCredential = (
  context: AuthAccessHttpContext,
  input: { readonly label?: string; readonly scopes?: ReadonlyArray<AuthGrantScope> },
) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...context,
    group: "auth",
    method: "POST",
    url: (urls) => urls.pairingCredential(),
    timeoutMs: 10_000,
    request: ({ client, headers }) => client.pairingCredential({ headers, payload: input }),
  });

export const revokeEnvironmentPairingLink = (context: AuthAccessHttpContext, id: string) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...context,
    group: "auth",
    method: "POST",
    url: (urls) => urls.revokePairingLink(),
    timeoutMs: 10_000,
    request: ({ client, headers }) => client.revokePairingLink({ headers, payload: { id } }),
  });

export const revokeEnvironmentClient = (context: AuthAccessHttpContext, sessionId: AuthSessionId) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...context,
    group: "auth",
    method: "POST",
    url: (urls) => urls.revokeClient(),
    timeoutMs: 10_000,
    request: ({ client, headers }) => client.revokeClient({ headers, payload: { sessionId } }),
  });

export const revokeOtherEnvironmentClients = (context: AuthAccessHttpContext) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...context,
    group: "auth",
    method: "POST",
    url: (urls) => urls.revokeOtherClients(),
    timeoutMs: 10_000,
    request: ({ client, headers }) => client.revokeOtherClients({ headers }),
  });

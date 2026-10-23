import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

type AuthenticatedRequest = Parameters<typeof executeAuthenticatedEnvironmentHttpRequest>[0];

export const requestEnvironmentLiveVoiceHistory = Effect.fn("clientRuntime.liveVoiceHistory.calls")(
  function* (
    input: Pick<AuthenticatedRequest, "prepared" | "signer" | "remoteAuthorization"> & {
      threadId: ThreadId;
      before?: string;
    },
  ) {
    const endpoint = {
      params: { threadId: input.threadId },
      query: input.before ? { before: input.before } : {},
    };
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      ...input,
      group: "liveVoiceHistory",
      method: "GET",
      timeoutMs: 10_000,
      url: (urls) => urls.calls(endpoint),
      request: ({ client, headers }) => client.calls({ ...endpoint, headers }),
    });
  },
);

export const requestEnvironmentLiveVoiceTranscript = Effect.fn(
  "clientRuntime.liveVoiceHistory.transcript",
)(function* (
  input: Pick<AuthenticatedRequest, "prepared" | "signer" | "remoteAuthorization"> & {
    threadId: ThreadId;
    leaseId: string;
    generation: number;
  },
) {
  const endpoint = {
    params: {
      threadId: input.threadId,
      leaseId: input.leaseId,
      generation: String(input.generation),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "liveVoiceHistory",
    method: "GET",
    timeoutMs: 10_000,
    url: (urls) => urls.transcript(endpoint),
    request: ({ client, headers }) => client.transcript({ ...endpoint, headers }),
  });
});

import type { VoiceRecordingStart, VoiceRecordingChunk } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

type Request =
  | { action: "settings" }
  | { action: "updateSettings"; enabled: boolean }
  | { action: "start"; input: typeof VoiceRecordingStart.Type }
  | { action: "append"; input: typeof VoiceRecordingChunk.Type }
  | { action: "finish"; id: string }
  | { action: "list" }
  | { action: "file"; id: string; role: "user" | "assistant" };
type Authorization = Pick<
  Parameters<typeof executeAuthenticatedEnvironmentHttpRequest>[0],
  "prepared" | "signer" | "remoteAuthorization"
>;

export const requestEnvironmentCallRecording = (authorization: Authorization, input: Request) => {
  const base = { ...authorization, group: "voiceRecording" as const, timeoutMs: 15_000 };
  switch (input.action) {
    case "settings":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "GET",
        url: (u) => u.settings(),
        request: ({ client, headers }) => client.settings({ headers }),
      }).pipe(Effect.map((value): unknown => value));
    case "updateSettings":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "PUT",
        url: (u) => u.updateSettings(),
        request: ({ client, headers }) =>
          client.updateSettings({ headers, payload: { enabled: input.enabled } }),
      }).pipe(Effect.map((value): unknown => value));
    case "start":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "POST",
        url: (u) => u.start(),
        request: ({ client, headers }) => client.start({ headers, payload: input.input }),
      }).pipe(Effect.map((value): unknown => value));
    case "append":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "POST",
        url: (u) => u.append(),
        request: ({ client, headers }) => client.append({ headers, payload: input.input }),
      }).pipe(Effect.map((value): unknown => value));
    case "finish":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "POST",
        url: (u) => u.finish(),
        request: ({ client, headers }) => client.finish({ headers, payload: { id: input.id } }),
      }).pipe(Effect.map((value): unknown => value));
    case "list":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "GET",
        url: (u) => u.list(),
        request: ({ client, headers }) => client.list({ headers }),
      }).pipe(Effect.map((value): unknown => value));
    case "file":
      return executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        timeoutMs: 60_000,
        method: "GET",
        url: (u) => u.file({ params: { id: input.id, role: input.role } }),
        request: ({ client, headers }) =>
          client.file({ headers, params: { id: input.id, role: input.role } }).pipe(
            Effect.flatMap(Stream.runCollect),
            Effect.map((chunks) => new Blob(chunks as BlobPart[])),
          ),
      }).pipe(Effect.map((value): unknown => value));
  }
};

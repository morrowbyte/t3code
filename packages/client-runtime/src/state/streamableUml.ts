import type { UmlRenderRequest, UmlRenderResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { FetchHttpClient } from "effect/http";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

export const renderEnvironmentUml = Effect.fn("clientRuntime.state.renderEnvironmentUml")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly remoteAuthorization: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
    readonly diagram: UmlRenderRequest;
    readonly signal: AbortSignal;
  }) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared: input.prepared,
      signer: input.signer,
      remoteAuthorization: input.remoteAuthorization,
      group: "streamableUi",
      method: "POST",
      timeoutMs: 10_000,
      url: (urls) => urls.renderUml(),
      request: ({ client, headers }) =>
        client.renderUml({ headers, payload: input.diagram }).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            signal: input.signal,
            ...(input.prepared.httpAuthorization == null
              ? { credentials: "include" as const }
              : {}),
          }),
        ),
    });
  },
);

/** A running render completes before a newer snapshot starts. Fast append
 * streams cannot starve the first useful image by repeatedly cancelling it. */
export function createUmlSnapshotQueue(input: {
  readonly render: (source: string, signal: AbortSignal) => Promise<UmlRenderResult>;
  readonly onResult: (result: UmlRenderResult, source: string) => void;
}) {
  const controller = new AbortController();
  const cache = new Map<string, Extract<UmlRenderResult, { status: "ready" }>>();
  let snapshots: readonly { readonly source: string }[] = [];
  let running = false;
  let lastAttempt: string | undefined;
  let hasImage = false;
  const pump = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      while (!controller.signal.aborted) {
        const newest = snapshots.at(-1)?.source;
        if (newest === undefined || newest === lastAttempt) break;
        lastAttempt = newest;
        // oxlint-disable-next-line unicorn/no-array-reverse -- Hermes lacks toReversed; only the copied array is mutated.
        const candidates = [...snapshots].reverse();
        let failure: UmlRenderResult = { status: "unavailable", reason: "render_failed" };
        for (const { source } of candidates) {
          if (controller.signal.aborted) return;
          let result: UmlRenderResult;
          try {
            result = cache.get(source) ?? (await input.render(source, controller.signal));
          } catch {
            result = { status: "unavailable", reason: "render_failed" };
          }
          if (controller.signal.aborted) return;
          if (result.status === "ready") {
            cache.set(source, result);
            while (
              cache.size > 24 ||
              [...cache.values()].reduce((bytes, frame) => bytes + frame.svg.length, 0) > 4_000_000
            )
              cache.delete(cache.keys().next().value!);
            hasImage = true;
            input.onResult(result, source);
            if (source !== newest) input.onResult(failure, newest);
            break;
          }
          failure = result;
          if (hasImage) {
            input.onResult(result, source);
            break;
          }
          if (source === candidates.at(-1)?.source) input.onResult(result, source);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    update: (next: readonly { readonly source: string }[]) => {
      snapshots = next;
      void pump();
    },
    retry: () => {
      lastAttempt = undefined;
      void pump();
    },
    dispose: () => controller.abort(),
  };
}

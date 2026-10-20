import { AndroidAppUpdateHttpError, EnvironmentHttpCommonError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientError, type HttpClientResponse } from "effect/http";
import type { PreparedConnection } from "../connection/model.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

interface AndroidAppUpdateConnection {
  readonly prepared: PreparedConnection;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
}

export const requestEnvironmentAndroidAppReleases = (input: AndroidAppUpdateConnection) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "androidAppUpdates",
    method: "GET",
    timeoutMs: 30_000,
    url: (urls) => urls.releases(),
    request: ({ client, headers }) => client.releases({ headers }),
  });

const decodeDownloadError = Schema.decodeUnknownEffect(
  Schema.toCodecJson(Schema.Union([EnvironmentHttpCommonError, AndroidAppUpdateHttpError])),
);

/** Consume inside the authorized request so cancellation also closes the HTTP download. */
export const consumeEnvironmentAndroidAppAsset = <A, E, R>(
  input: AndroidAppUpdateConnection & {
    readonly releaseId: string;
    readonly assetId: string;
    readonly consume: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>;
  },
) =>
  executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "androidAppUpdates",
    method: "GET",
    timeoutMs: 10 * 60_000,
    url: (urls) => urls.asset({ params: { releaseId: input.releaseId, assetId: input.assetId } }),
    request: ({ client, headers }) =>
      client
        .asset({
          params: { releaseId: input.releaseId, assetId: input.assetId },
          headers,
          responseMode: "response-only",
        })
        .pipe(
          Effect.flatMap((response) =>
            Effect.gen(function* () {
              if (response.status === 200) return yield* input.consume(response);
              const failure = new HttpClientError.HttpClientError({
                reason: new HttpClientError.StatusCodeError({
                  request: response.request,
                  response,
                }),
              });
              return yield* response.json.pipe(
                Effect.flatMap(decodeDownloadError),
                Effect.matchEffect({
                  onFailure: () => Effect.fail(failure),
                  onSuccess: Effect.fail,
                }),
              );
            }),
          ),
        ),
  });

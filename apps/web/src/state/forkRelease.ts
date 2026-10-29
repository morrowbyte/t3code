import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { cliReleaseIndexPageUrl, newestCliReleaseVersion } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { Atom } from "effect/reactivity";

const Releases = Schema.Array(
  Schema.Struct({ tag_name: Schema.String, draft: Schema.optionalKey(Schema.Boolean) }),
);

export const forkReleaseAtom = Atom.family((channel: DesktopUpdateChannel) =>
  Atom.make(
    Effect.gen(function* () {
      for (let page = 1; page <= 5; page++) {
        const response = yield* HttpClient.get(cliReleaseIndexPageUrl(page));
        const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap((ok) => ok.json),
          Effect.flatMap(Schema.decodeUnknownEffect(Releases)),
        );
        const version = newestCliReleaseVersion(body, channel === "latest" ? "stable" : "nightly");
        if (version !== undefined) {
          // Fork releases do not yet publish a verified migration manifest; cross-track installs stay blocked.
          return { version, databaseMigration: undefined };
        }
        if (body.length < 100) break;
      }
      return null;
    }).pipe(
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.provide(FetchHttpClient.layer),
    ),
  ).pipe(Atom.withRefresh("5 minutes"), Atom.withLabel(`fork-release:${channel}`)),
);

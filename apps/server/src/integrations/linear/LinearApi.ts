import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { LinearIntegrationError } from "@t3tools/contracts";

const Identity = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
});
const Issue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  url: Schema.String,
  updatedAt: Schema.String,
  team: Schema.Struct({ id: Schema.String }),
  project: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});
const Token = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
});

export class LinearApi extends Context.Service<
  LinearApi,
  {
    readonly token: (input: {
      readonly clientId: string;
      readonly redirectUri: string;
      readonly code: string;
      readonly verifier: string;
    }) => Effect.Effect<typeof Token.Type, LinearIntegrationError>;
    readonly identity: (
      token: string,
    ) => Effect.Effect<typeof Identity.Type, LinearIntegrationError>;
    readonly issue: (
      token: string,
      issueId: string,
    ) => Effect.Effect<typeof Issue.Type, LinearIntegrationError>;
  }
>()("t3/integrations/linear/LinearApi") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const execute = Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
    const response = yield* client.execute(request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(() => new LinearIntegrationError({ reason: "offline" })),
    );
    if (response.status === 401 || response.status === 403)
      return yield* new LinearIntegrationError({ reason: "revoked" });
    if (response.status < 200 || response.status >= 300)
      return yield* new LinearIntegrationError({ reason: "offline" });
    return response;
  });
  const graphql = Effect.fn("LinearApi.graphql")(
    <A, I>(
      token: string,
      query: string,
      variables: Record<string, string>,
      schema: Schema.Codec<A, I>,
    ) =>
      Effect.gen(function* () {
        const response = yield* execute(
          HttpClientRequest.post("https://api.linear.app/graphql").pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${token}`),
            HttpClientRequest.bodyJsonUnsafe({ query, variables }),
          ),
        );
        const envelope = yield* HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            data: Schema.optional(Schema.NullOr(schema)),
            errors: Schema.optional(
              Schema.Array(
                Schema.Struct({
                  extensions: Schema.optional(
                    Schema.Struct({ code: Schema.optional(Schema.String) }),
                  ),
                }),
              ),
            ),
          }),
        )(response).pipe(Effect.mapError(() => new LinearIntegrationError({ reason: "invalid" })));
        if (
          envelope.errors?.some((error) =>
            ["AUTHENTICATION_ERROR", "UNAUTHENTICATED", "FORBIDDEN"].includes(
              error.extensions?.code ?? "",
            ),
          )
        )
          return yield* new LinearIntegrationError({ reason: "revoked" });
        if (!envelope.data || envelope.errors?.length)
          return yield* new LinearIntegrationError({ reason: "invalid" });
        return envelope.data;
      }).pipe(Effect.withTracerEnabled(false)),
  );
  return LinearApi.of({
    token: Effect.fn("LinearApi.token")((input) =>
      Effect.gen(function* () {
        const response = yield* execute(
          HttpClientRequest.post("https://api.linear.app/oauth/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: input.clientId,
              redirect_uri: input.redirectUri,
              code: input.code,
              code_verifier: input.verifier,
              grant_type: "authorization_code",
            }),
          ),
        );
        return yield* HttpClientResponse.schemaBodyJson(Token)(response).pipe(
          Effect.mapError(() => new LinearIntegrationError({ reason: "invalid" })),
        );
      }).pipe(Effect.withTracerEnabled(false)),
    ),
    identity: Effect.fn("LinearApi.identity")((token) =>
      graphql(token, "query { viewer { id } organization { id name } }", {}, Identity),
    ),
    issue: Effect.fn("LinearApi.issue")((token, issueId) =>
      graphql(
        token,
        "query($id: String!) { issue(id: $id) { id identifier title description url updatedAt team { id } project { id } } }",
        { id: issueId },
        Schema.Struct({ issue: Issue }),
      ).pipe(Effect.map((data) => data.issue)),
    ),
  });
});
export const layer = Layer.effect(LinearApi, make);

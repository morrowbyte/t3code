import { BoatError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientRequest } from "effect/http";

type Method = "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
export class BoatApi extends Context.Service<
  BoatApi,
  {
    readonly request: (
      key: Redacted.Redacted<string>,
      path: string,
      method?: Method,
      body?: unknown,
      idempotencyKey?: string,
    ) => Effect.Effect<unknown, BoatError>;
  }
>()("t3/boat/BoatApi") {}

export const layer = Layer.effect(
  BoatApi,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return {
      request: Effect.fn("BoatApi.request")(function* (
        key: Redacted.Redacted<string>,
        path: string,
        method: Method = "GET",
        body?: unknown,
        idempotencyKey?: string,
      ) {
        let request = HttpClientRequest.make(method)(`https://boat.dev/api/v1${path}`).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(key)}`),
        );
        if (method === "DELETE" && /^\/sandboxes\/[^/?]+$/.test(path))
          request = HttpClientRequest.setHeader(
            request,
            "X-Ascii-Confirm-Delete",
            decodeURIComponent(path.split("/").at(-1)!),
          );
        if (body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, body);
        if (idempotencyKey)
          request = HttpClientRequest.setHeader(request, "Idempotency-Key", idempotencyKey);
        const response = yield* client.execute(request).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(() => new BoatError({ category: "provider" })),
        );
        if (response.status < 200 || response.status >= 300)
          return yield* new BoatError({
            category: response.status === 401 ? "invalid_key" : "provider",
            status: response.status,
          });
        if (response.status === 204) return {};
        return yield* response.json.pipe(
          Effect.mapError(() => new BoatError({ category: "provider" })),
        );
      }),
    };
  }),
);

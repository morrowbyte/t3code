import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  ProviderEvalRequest,
  ProviderEvalResponse,
} from "../../apps/server/src/provider/ProviderEvalSession.ts";

export const CREW_STDIO_PREFIX = "@@CREW_PROVIDER_EVAL_V1@@";
export const CREW_MAX_LINE_LENGTH = 262_144;
export const CREW_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
export const CREW_MAX_REQUESTS = 512;

const count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 36 }));
export const CrewSummary = Schema.Struct({
  cases: count,
  samples: count,
  passed: count,
  failed: count,
  errors: count,
  usage: Schema.Literal("unknown"),
});
export type CrewSummary = typeof CrewSummary.Type;

const id = Schema.String.check(Schema.isPattern(/^request-[1-9][0-9]{0,3}$/));
export const CrewRunnerFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready"), version: Schema.Literal(1) }),
  Schema.Struct({ type: Schema.Literal("request"), id, request: ProviderEvalRequest }),
  Schema.Struct({ type: Schema.Literal("result"), summary: CrewSummary }),
]);
export const CrewHostFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("response"), id, response: ProviderEvalResponse }),
  Schema.Struct({ type: Schema.Literal("error"), id, code: Schema.Literal("provider_failed") }),
]);

export class CrewProtocolError extends Schema.TaggedError<CrewProtocolError>()(
  "CrewProtocolError",
  {
    code: Schema.Literals([
      "missing_bridge",
      "invalid_frame",
      "response_mismatch",
      "provider_failed",
      "limit",
    ]),
  },
) {
  override get message(): string {
    return `Crew stdio bridge failed (${this.code}). Use provider_eval_boat with the matching runner.`;
  }
}

export const encodeCrewFrame = (frame: typeof CrewRunnerFrame.Type | typeof CrewHostFrame.Type) =>
  `${CREW_STDIO_PREFIX}${JSON.stringify(frame)}\n`;

export const decodeCrewFrame = <S extends Schema.Top>(schema: S, line: string) => {
  if (!line.startsWith(CREW_STDIO_PREFIX)) {
    return Effect.fail(new CrewProtocolError({ code: "missing_bridge" }));
  }
  if (line.length > CREW_MAX_LINE_LENGTH) {
    return Effect.fail(new CrewProtocolError({ code: "limit" }));
  }
  return Schema.decodeEffect(Schema.fromJsonString(schema))(
    line.slice(CREW_STDIO_PREFIX.length),
  ).pipe(Effect.mapError(() => new CrewProtocolError({ code: "invalid_frame" })));
};

export interface CrewProviderClient {
  readonly run: (
    request: ProviderEvalRequest,
  ) => Effect.Effect<ProviderEvalResponse, CrewProtocolError>;
}

export const makeCrewProviderClient = (
  readLine: Effect.Effect<string | undefined, CrewProtocolError>,
  writeLine: (line: string) => Effect.Effect<void, CrewProtocolError>,
): CrewProviderClient => {
  let sequence = 0;
  let closed = false;
  return {
    run: Effect.fn("CrewProviderClient.run")(
      function* (request: ProviderEvalRequest) {
        if (closed) return yield* new CrewProtocolError({ code: "missing_bridge" });
        if (++sequence > CREW_MAX_REQUESTS) return yield* new CrewProtocolError({ code: "limit" });
        const id = `request-${sequence}`;
        const line = encodeCrewFrame({ type: "request", id, request });
        if (line.length > CREW_MAX_LINE_LENGTH)
          return yield* new CrewProtocolError({ code: "limit" });
        yield* writeLine(line);
        const incoming = yield* readLine.pipe(
          Effect.timeoutOrElse({
            duration: "11 minutes",
            orElse: () => Effect.fail(new CrewProtocolError({ code: "missing_bridge" })),
          }),
        );
        if (incoming === undefined) return yield* new CrewProtocolError({ code: "missing_bridge" });
        const frame = yield* decodeCrewFrame(CrewHostFrame, incoming);
        if (frame.id !== id) return yield* new CrewProtocolError({ code: "response_mismatch" });
        if (frame.type === "error")
          return yield* new CrewProtocolError({ code: "provider_failed" });
        return frame.response;
      },
      Effect.tapError(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          closed = true;
        }),
      ),
    ),
  };
};

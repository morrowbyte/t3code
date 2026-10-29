import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";

it.each([undefined, false, true])(
  "compacts schemas without changing strict mode (%s)",
  (strict) => {
    const closed = strict === true ? { additionalProperties: false } : {};
    const Every = Schema.Struct({ ms: Schema.Int });
    const tool = Tool.make("example", {
      parameters: Schema.Struct({
        threadId: Schema.optional(Schema.NullOr(Schema.String)),
        beforeRunId: Schema.NullOr(Schema.String),
        limit: Schema.optional(Schema.Int),
        every: Schema.Union([Every, Schema.fromJsonString(Every)]),
        target: Schema.optional(
          Schema.NullOr(
            Schema.Union([
              Schema.Struct({ kind: Schema.Literal("url"), url: Schema.String }),
              Schema.Struct({ kind: Schema.Literal("number"), number: Schema.Int }),
            ]),
          ),
        ),
      }),
    }).annotate(Tool.Strict, strict);

    expect(advertisedJsonSchema(tool)).toEqual({
      type: "object",
      ...closed,
      properties: {
        threadId: { type: "string" },
        beforeRunId: { anyOf: [{ type: "string" }, { type: "null" }] },
        limit: { type: "integer" },
        every: {
          type: "object",
          ...closed,
          properties: { ms: { type: "integer" } },
          required: ["ms"],
        },
        target: {
          type: "object",
          ...closed,
          properties: {
            kind: { type: "string", enum: ["url", "number"] },
            url: { type: "string" },
            number: { type: "integer" },
          },
          required: ["kind"],
        },
      },
      required: ["beforeRunId", "every"],
    });
  },
);

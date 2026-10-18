import * as Schema from "effect/Schema";

const UmlKind = Schema.Literals(["sequence", "class", "state", "usecase", "activity"]);
const UmlPalette = Schema.Struct({
  background: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  surface: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  foreground: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  muted: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  border: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  primary: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
});
export const UmlRenderRequest = Schema.Struct({
  kind: UmlKind,
  source: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16_000)),
  palette: UmlPalette,
});
export type UmlRenderRequest = typeof UmlRenderRequest.Type;

export const UmlRenderResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    svg: Schema.String.check(Schema.isMaxLength(1_000_000)),
    width: Schema.Number,
    height: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literals(["invalid", "unsupported", "busy", "timeout", "render_failed"]),
  }),
]);
export type UmlRenderResult = typeof UmlRenderResult.Type;

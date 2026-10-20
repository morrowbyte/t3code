import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PickerId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const Cols = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }));
const Rows = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

export const YaziPickerOpenInput = Schema.Struct({ cols: Cols, rows: Rows });
export type YaziPickerOpenInput = typeof YaziPickerOpenInput.Type;
export const YaziPickerSessionInput = Schema.Struct({ sessionId: PickerId });
export type YaziPickerSessionInput = typeof YaziPickerSessionInput.Type;
export const YaziPickerWriteInput = Schema.Struct({
  sessionId: PickerId,
  data: Schema.String.check(Schema.isMaxLength(65536)),
});
export type YaziPickerWriteInput = typeof YaziPickerWriteInput.Type;
export const YaziPickerResizeInput = Schema.Struct({ sessionId: PickerId, cols: Cols, rows: Rows });
export type YaziPickerResizeInput = typeof YaziPickerResizeInput.Type;
export const YaziPickerReadInput = Schema.Struct({
  sessionId: PickerId,
  fileId: PickerId,
  offset: NonNegativeInt,
});
export type YaziPickerReadInput = typeof YaziPickerReadInput.Type;
export const YaziPickerOpened = Schema.Struct({ sessionId: PickerId, homePath: Schema.String });
export type YaziPickerOpened = typeof YaziPickerOpened.Type;
export const YaziPickerFile = Schema.Struct({
  id: PickerId,
  name: Schema.String,
  mimeType: Schema.String,
  sizeBytes: NonNegativeInt,
});
export type YaziPickerFile = typeof YaziPickerFile.Type;
export const YaziPickerPollResult = Schema.Struct({
  output: Schema.String,
  state: Schema.Literals(["running", "completed", "cancelled", "failed"]),
  files: Schema.Array(YaziPickerFile),
  error: Schema.optional(Schema.String),
});
export type YaziPickerPollResult = typeof YaziPickerPollResult.Type;
export const YaziPickerReadResult = Schema.Struct({
  dataBase64: Schema.String,
  eof: Schema.Boolean,
});
export type YaziPickerReadResult = typeof YaziPickerReadResult.Type;

export class YaziPickerError extends Schema.TaggedError<YaziPickerError>()("YaziPickerError", {
  reason: Schema.Literals(["unavailable", "session", "limit", "selection", "read", "terminal"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Yazi could not be started. Install yazi on the selected device or environment and make it available on PATH.";
      case "session":
        return "This file picker session is unavailable or belongs to another connection.";
      case "limit":
        return "The file picker limit was reached. Close an existing picker and try again.";
      case "selection":
        return "Yazi must select regular files within the attachment count and size limits.";
      case "read":
        return "A selected file could not be read or changed after selection. Select it again.";
      case "terminal":
        return "The Yazi terminal could not be updated.";
    }
  }
}

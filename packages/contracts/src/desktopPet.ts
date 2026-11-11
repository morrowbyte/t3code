import * as Schema from "effect/Schema";

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Token = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/));
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const DesktopPetSettings = Schema.Struct({
  persistent: Schema.Boolean,
  visible: Schema.Boolean,
  reducedMotion: Schema.Boolean,
  executable: Schema.String.check(Schema.isMaxLength(4096)),
  shortcut: Schema.String.check(Schema.isMaxLength(120)),
}).annotate(strict);
export type DesktopPetSettings = typeof DesktopPetSettings.Type;
export const DEFAULT_DESKTOP_PET_SETTINGS: DesktopPetSettings = {
  persistent: false,
  visible: true,
  reducedMotion: false,
  executable: "weasel-desktop-pet",
  shortcut: "",
};

export const DESKTOP_PET_SUMMARIES = {
  approval: "An agent needs your approval.",
  question: "An agent has a question for you.",
  result: "An agent has a completed response.",
} as const;
export const DesktopPetItemKind = Schema.Literals(["approval", "question", "result"]);
export type DesktopPetItemKind = typeof DesktopPetItemKind.Type;
export const MAX_DESKTOP_PET_SUMMARY_LENGTH = 240;
const PetSummary = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/\S/),
  Schema.isMaxLength(MAX_DESKTOP_PET_SUMMARY_LENGTH),
  Schema.isPattern(/^[^\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/),
);
export const DesktopPetProjection = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("projection"),
  revision: Count,
  workingCount: Count,
  items: Schema.Array(
    Schema.Struct({
      id: Token,
      kind: DesktopPetItemKind,
      summary: PetSummary,
    }).annotate(strict),
  ).check(Schema.isMaxLength(20)),
}).annotate(strict);
export type DesktopPetProjection = typeof DesktopPetProjection.Type;

export const DesktopPetAction = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("action"),
  id: Token,
  action: Schema.Literals(["open", "dismiss"]),
}).annotate(strict);
export type DesktopPetAction = typeof DesktopPetAction.Type;

export const DesktopPetCapabilities = Schema.Struct({
  nativeOverlay: Schema.Boolean,
  focusMonitor: Schema.Boolean,
  customPet: Schema.Boolean,
  computerUse: Schema.Boolean,
}).annotate(strict);
export const DesktopPetNativeState = Schema.Struct({
  v: Schema.Literal(1),
  type: Schema.Literal("state"),
  visible: Schema.Boolean,
  persistent: Schema.Boolean,
  monitor: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
  computerUse: Schema.NullOr(
    Schema.Struct({
      sessionId: Schema.String.check(Schema.isMaxLength(256)),
      epoch: Count,
      taskId: Schema.NullOr(Schema.String.check(Schema.isMaxLength(256))),
      observationMode: Schema.Literals(["enabled", "disabled"]),
      observationActive: Schema.Boolean,
      observationGeneration: Count,
    }).annotate(strict),
  ),
}).annotate(strict);
export type DesktopPetNativeState = typeof DesktopPetNativeState.Type;

const StableCode = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/));
export const DesktopPetNativeEvent = Schema.Union([
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("ready"),
    capabilities: DesktopPetCapabilities,
  }).annotate(strict),
  DesktopPetNativeState,
  DesktopPetAction,
  Schema.Struct({ v: Schema.Literal(1), type: Schema.Literal("error"), code: StableCode }).annotate(
    strict,
  ),
  Schema.Struct({
    v: Schema.Literal(1),
    type: Schema.Literal("disconnected"),
    reason: StableCode,
  }).annotate(strict),
]);
export type DesktopPetNativeEvent = typeof DesktopPetNativeEvent.Type;

export const DesktopPetStatus = Schema.Struct({
  settings: DesktopPetSettings,
  connection: Schema.Literals(["starting", "ready", "unavailable", "unsupported", "disconnected"]),
  capabilities: Schema.NullOr(DesktopPetCapabilities),
  native: Schema.NullOr(DesktopPetNativeState),
  error: Schema.NullOr(StableCode),
  shortcutRegistered: Schema.Boolean,
  shortcutBackend: Schema.NullOr(Schema.Literals(["global", "niri"])),
  shortcutError: Schema.NullOr(StableCode),
  customPet: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
});
export type DesktopPetStatus = typeof DesktopPetStatus.Type;
export type DesktopPetEvent =
  | { readonly type: "status"; readonly status: DesktopPetStatus }
  | DesktopPetAction;

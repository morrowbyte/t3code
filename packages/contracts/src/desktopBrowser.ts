import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

const ControlId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const strictControl = <const Fields extends Schema.Struct.Fields>(fields: Fields) => {
  const keys = new Set(Object.keys(fields));
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(Schema.String, Schema.Unknown),
  ])
    .check(
      Schema.makeFilter((value) => Object.keys(value).every((key) => keys.has(key)), {
        expected: "only desktop private-entry control fields",
        toJsonSchema: () => [{ additionalProperties: false }, true],
      }),
    )
    .pipe(Schema.decodeTo(Schema.Struct(fields)));
};

/** Capability of this exact FD subscription and webContents attachment; absence means unsupported. */
const AttachmentFields = { channelEpoch: ControlId, attachmentId: ControlId };
export const DesktopBrowserPrivateEntryAttachment = strictControl(AttachmentFields);
export type DesktopBrowserPrivateEntryAttachment = typeof DesktopBrowserPrivateEntryAttachment.Type;
const ControlTarget = { ...TabKey, ...AttachmentFields };
const RequestBinding = { ...ControlTarget, requestId: ControlId };
const LeaseBinding = { ...RequestBinding, leaseId: ControlId, generation: NonNegativeInt };

export const DesktopBrowserPrivateEntryRequest = Schema.Union([
  strictControl({ type: Schema.Literal("private-entry-acquire"), ...RequestBinding }),
  // Cancels pending acquisition or its late grant; no credentials have been read on a timeout.
  strictControl({ type: Schema.Literal("private-entry-cancel"), ...RequestBinding }),
  strictControl({ type: Schema.Literal("private-entry-release"), ...LeaseBinding }),
]);
export type DesktopBrowserPrivateEntryRequest = typeof DesktopBrowserPrivateEntryRequest.Type;

export const DesktopBrowserPrivateEntryResponse = Schema.Union([
  strictControl({ type: Schema.Literal("private-entry-granted"), ...LeaseBinding }),
  strictControl({
    type: Schema.Literal("private-entry-refused"),
    ...RequestBinding,
    reason: Schema.Literals([
      "unavailable",
      "agent-owned",
      "viewer-owned",
      "stale",
      "cancelled",
      "busy",
    ]),
  }),
  // ACK echoes the RELEASED lease generation, not the new unclaimed control generation.
  strictControl({ type: Schema.Literal("private-entry-released"), ...LeaseBinding }),
  strictControl({
    type: Schema.Literal("private-entry-revoked"),
    ...LeaseBinding,
    reason: Schema.Literals([
      "detached",
      "closed",
      "control-changed",
      "cancelled",
      "channel-closed",
    ]),
  }),
]);
export type DesktopBrowserPrivateEntryResponse = typeof DesktopBrowserPrivateEntryResponse.Type;

/** Desktop -> server. */
export const DesktopBrowserEvent = Schema.Union([
  DesktopBrowserPrivateEntryRequest,
  /** A desktop `<webview>` for this server tab is attached and can be driven. */
  Schema.Struct({
    type: Schema.Literal("attached"),
    ...TabKey,
    privateEntry: Schema.optionalKey(DesktopBrowserPrivateEntryAttachment),
  }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({
    type: Schema.Literal("detached"),
    ...TabKey,
    privateEntry: Schema.optionalKey(DesktopBrowserPrivateEntryAttachment),
  }),
  /** One CDP message from the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  DesktopBrowserPrivateEntryResponse,
  /** One CDP message for the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Whether an agent turn runs on the thread, so the tabs it uses stay focused between steps. */
  Schema.Struct({
    type: Schema.Literal("turn"),
    threadId: TrimmedNonEmptyString,
    active: Schema.Boolean,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;

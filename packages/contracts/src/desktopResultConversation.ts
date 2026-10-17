import * as Schema from "effect/Schema";

import { EnvironmentId, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { JarvisNativeTaskOrigin } from "./jarvis.ts";
import { NativeAuthorRootLocator } from "./nativeAuthor.ts";

const DelegatedResultConversationLocator = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  origin: JarvisNativeTaskOrigin,
}).check(
  Schema.makeFilter(
    (locator) =>
      locator.environmentId === locator.origin.environmentId &&
      locator.threadId === locator.origin.childThreadId &&
      Object.values(locator.origin).every((value) => value.trim().length > 0),
  ),
);
export const DesktopResultConversationLocator = Schema.Union([
  DelegatedResultConversationLocator,
  Schema.Struct({
    environmentId: EnvironmentId,
    threadId: ThreadId,
    origin: NativeAuthorRootLocator,
  }).check(
    Schema.makeFilter(
      (locator) =>
        locator.environmentId === locator.origin.environmentId &&
        locator.threadId === locator.origin.threadId,
    ),
  ),
]);
export type DesktopResultConversationLocator = typeof DesktopResultConversationLocator.Type;
const isResultConversationLocator = Schema.is(DelegatedResultConversationLocator);

// The caller resolves a canonical delegation receipt. This operation only opens
// its existing authenticated conversation; it never creates work or supplies content.
export const DesktopResultConversationRequest = Schema.Struct({
  version: Schema.Literal(1),
  requestId: TrimmedNonEmptyString,
  type: Schema.Literal("open-result-conversation"),
  ...DelegatedResultConversationLocator.fields,
}).check(Schema.makeFilter(isResultConversationLocator));
export type DesktopResultConversationRequest = typeof DesktopResultConversationRequest.Type;

export const DesktopResultConversationResponse = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(true),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    windowId: PositiveInt,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    requestId: TrimmedNonEmptyString,
    ok: Schema.Literal(false),
    code: Schema.Literals(["invalid-request", "result-window-unavailable"]),
    message: TrimmedNonEmptyString,
  }),
]);
export type DesktopResultConversationResponse = typeof DesktopResultConversationResponse.Type;

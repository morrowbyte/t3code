import {
  AuthSessionId,
  EnvironmentId,
  ThreadId,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u));
const Thumbprint = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
const HumanIdentity = { sessionId: AuthSessionId, subject: Identifier };
const Human = Schema.Union([
  Schema.Struct({
    ...HumanIdentity,
    sourceKind: Schema.Literal("human"),
    testOnly: Schema.Literal(false),
  }),
  Schema.Struct({
    ...HumanIdentity,
    sourceKind: Schema.Literal("synthetic"),
    testOnly: Schema.Literal(true),
  }),
]);
export const ForwardDestination = Schema.Struct({
  environmentId: EnvironmentId,
  forward: Schema.Struct({
    proofKeySecretName: Identifier,
    credentialSecretName: Identifier,
    sessionId: AuthSessionId,
    subject: Identifier,
    developmentHttpBaseUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(2_048))),
  }),
});
export type ForwardDestination = typeof ForwardDestination.Type;
export const PairedVm = Schema.Struct({
  ...ForwardDestination.fields,
  hostThreadId: ThreadId,
  vmId: Identifier,
  label: Schema.String.check(Schema.isMaxLength(200)),
  threadId: ThreadId,
  sessionId: AuthSessionId,
  subject: Identifier,
  proofKeyThumbprint: Thumbprint,
});
export type PairedVm = typeof PairedVm.Type;
const Policy = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  humans: Schema.Array(Human).check(Schema.isMaxLength(16)),
  channels: Schema.Array(PairedVm).check(Schema.isMaxLength(16)),
  receiver: Schema.optional(
    Schema.Struct({
      sessionId: AuthSessionId,
      subject: Identifier,
      proofKeyThumbprint: Thumbprint,
      threadId: ThreadId,
      testOnly: Schema.Boolean,
      host: Schema.optional(ForwardDestination),
    }),
  ),
});
export class ApprovalReviewOrderPolicy extends Context.Reference<typeof Policy.Type>(
  "t3/ApprovalReviewOrderPolicy",
  { defaultValue: () => ({ enabled: false, humans: [], channels: [] }) },
) {}
export const layer = Layer.effect(
  ApprovalReviewOrderPolicy,
  Effect.gen(function* () {
    const json = yield* Config.String("T3CODE_APPROVAL_REVIEW_HOST_POLICY").pipe(
      Config.withDefault('{"enabled":false,"humans":[],"channels":[]}'),
    );
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Policy))(json, {
      onExcessProperty: "error",
    });
  }),
);
export function humanFor(policy: typeof Policy.Type, actor: EnvironmentSessionPrincipalShape) {
  return actor.method === "browser-session-cookie"
    ? policy.humans.find(
        (human) => human.sessionId === actor.sessionId && human.subject === actor.subject,
      )
    : undefined;
}
export function matchesVm(channel: PairedVm, actor: EnvironmentSessionPrincipalShape) {
  return (
    actor.method === "dpop-access-token" &&
    actor.sessionId === channel.sessionId &&
    actor.subject === channel.subject &&
    actor.proofKeyThumbprint === channel.proofKeyThumbprint &&
    actor.scopes.has("approval-review:request") &&
    [...actor.scopes].every((scope) => scope === "approval-review:request")
  );
}

import type {
  VoiceIntakeDecision,
  VoiceIntakeSnapshot,
} from "../../packages/contracts/src/voiceIntake.ts";
import type { IntakeCase } from "./cases.ts";

export function grade(
  testCase: IntakeCase,
  snapshot: VoiceIntakeSnapshot,
  decision: VoiceIntakeDecision,
) {
  const failures: string[] = [];
  if (decision.requestId !== snapshot.requestId) failures.push("request_id");
  if (testCase.expected.type === "conversation") {
    if (decision.actions.length !== 0) failures.push("conversation_created_action");
  } else {
    if (decision.actions.length !== 1) failures.push("action_count");
    const action = decision.actions[0];
    if (action?.type !== testCase.expected.type) failures.push("action_type");
    if (
      testCase.expected.intentId &&
      (!action || !("intentId" in action) || action.intentId !== testCase.expected.intentId)
    )
      failures.push("intent_identity");
    if (
      testCase.expected.readOnly !== undefined &&
      (!action || !("readOnly" in action) || action.readOnly !== testCase.expected.readOnly)
    )
      failures.push("read_only");
    if (
      action?.type === "new" &&
      action.projectId !== null &&
      action.projectId !== snapshot.defaultProjectId
    )
      failures.push("project_identity");
    const request =
      action && ("request" in action ? action.request : "message" in action ? action.message : "");
    for (const pattern of testCase.expected.required)
      if (!pattern.test(request ?? "")) failures.push(`missing:${pattern.source}`);
    for (const pattern of testCase.expected.forbidden)
      if (pattern.test(request ?? "")) failures.push(`unsupported:${pattern.source}`);
  }
  for (const action of decision.actions) {
    if (!("sources" in action)) continue;
    for (const source of action.sources) {
      const segment = snapshot.segments.find((candidate) => candidate.id === source.segmentId);
      if (!segment || segment.revision !== source.revision) {
        failures.push("source_identity");
        continue;
      }
      const start = segment.text.indexOf(source.quote);
      if (start < 0 || source.quote.trim().length === 0) failures.push("source_not_verbatim");
      else if (segment.text.indexOf(source.quote, start + 1) >= 0)
        failures.push("source_ambiguous");
      if (
        snapshot.intents.some((intent) =>
          intent.sources.some(
            (claimed) =>
              claimed.segmentId === source.segmentId &&
              claimed.revision === source.revision &&
              start < claimed.end &&
              start + source.quote.length > claimed.start,
          ),
        )
      )
        failures.push("source_already_claimed");
    }
  }
  return { pass: failures.length === 0, failures };
}

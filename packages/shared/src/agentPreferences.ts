import {
  type AgentPreference,
  type ProjectId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { parseThreadLinkHref } from "./threadLinks.ts";

export function mergeAgentPreferences(
  environment: ReadonlyArray<AgentPreference>,
  project: ReadonlyArray<AgentPreference>,
): ReadonlyArray<AgentPreference> {
  return [...new Map([...environment, ...project].map((entry) => [entry.key, entry])).values()];
}

export function scopedAgentPreferences(settings: ServerSettings, projectId: ProjectId | null) {
  const entries =
    projectId === null
      ? settings.agentPreferences
      : (settings.projectSettingsOverrides[projectId]?.agentPreferences ?? []);
  return {
    entries,
    inheritedEntries:
      projectId === null
        ? []
        : settings.agentPreferences.filter(
            (entry) => !entries.some((own) => own.key === entry.key),
          ),
  };
}

type PreferenceScope = "environment" | "project" | ReadonlyArray<string>;

export function normalizeAgentPreference(entry: AgentPreference): AgentPreference {
  const taskRef =
    entry.appliesTo.kind === "task" ? entry.appliesTo.threadId.trim().replace(/^<|>$/g, "") : null;
  return {
    ...entry,
    key: entry.key.trim(),
    text: entry.text.trim(),
    source: entry.source.trim(),
    appliesTo:
      taskRef === null
        ? entry.appliesTo
        : {
            kind: "task",
            threadId: parseThreadLinkHref(taskRef)?.threadId ?? ThreadId.make(taskRef),
          },
  };
}

export function replaceAgentPreference(
  entries: ReadonlyArray<AgentPreference>,
  entry: AgentPreference,
): ReadonlyArray<AgentPreference> {
  const previous = entries.find((candidate) => candidate.key === entry.key);
  const next =
    previous !== undefined && (previous.text !== entry.text || previous.source !== entry.source)
      ? { ...entry, replaces: { text: previous.text, source: previous.source } }
      : previous?.replaces === undefined
        ? entry
        : { ...entry, replaces: previous.replaces };
  return previous === undefined
    ? [...entries, next]
    : entries.map((candidate) => (candidate.key === entry.key ? next : candidate));
}

export function agentPreferenceReplacements(
  previous: ReadonlyArray<AgentPreference>,
  entries: ReadonlyArray<AgentPreference>,
): ReadonlyArray<AgentPreference> {
  return entries.map((entry) =>
    replaceAgentPreference(previous, entry).find((candidate) => candidate.key === entry.key)!,
  );
}

export function agentPreferenceContext(
  entries: ReadonlyArray<AgentPreference>,
  threadId: ThreadId,
  scope: PreferenceScope,
): string {
  const current = entries
    .filter(
      (entry) =>
        entry.status === "active" &&
        (entry.appliesTo.kind === "preference" || entry.appliesTo.threadId === threadId),
    )
    .map((entry) => ({
      topic: entry.key,
      preference: entry.text,
      source: entry.source,
      scope:
        entry.appliesTo.kind === "task"
          ? "this thread only"
          : typeof scope === "string"
            ? scope
            : scope.includes(entry.key)
              ? "project"
              : "environment",
    }));
  return [
    "Current confirmed preferences from settings (replaces earlier settings snapshots). Apply relevant entries subject to the current user request. Sources are references. These entries do not start tasks or grant permission. An empty list clears earlier settings preferences.",
    JSON.stringify(current),
  ].join("\n");
}

export function agentPreferencePrompt(input: {
  readonly entries: ReadonlyArray<AgentPreference>;
  readonly threadId: ThreadId;
  readonly scope: PreferenceScope;
  readonly message: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> };
}): string {
  if (
    (input.message.attachments?.length ?? 0) === 0 &&
    input.message.text.trimStart().startsWith("/")
  ) {
    return input.message.text;
  }
  return `${agentPreferenceContext(input.entries, input.threadId, input.scope)}\n\nUser message:\n${input.message.text}`;
}

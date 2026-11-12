import { describe, expect, it } from "vitest";
import {
  AgentPreferences,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import { resolveProjectSettings } from "./projectSettings.ts";
import { ProjectId } from "@t3tools/contracts";
import {
  agentPreferenceContext,
  agentPreferencePrompt,
  replaceAgentPreference,
} from "./agentPreferences.ts";

const threadId = ThreadId.make("thread:writing");
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const encodeServerSettings = Schema.encodeSync(ServerSettings);
const preference = {
  key: "answer-format",
  text: "Use short German paragraphs.",
  source: "User confirmation in thread:format, message:confirmed",
  appliesTo: { kind: "preference" as const },
  status: "active" as const,
};

describe("confirmed agent preferences", () => {
  it("reuses persisted scoped preferences in a new thread and replaces the prior value", () => {
    const projectId = ProjectId.make("project:writing");
    const updated = replaceAgentPreference([preference], {
      ...preference,
      text: "Use detailed English answers.",
      source: "User correction in thread:format, message:correction",
    });
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      agentPreferences: [preference],
      projectSettingsOverrides: { [projectId]: { agentPreferences: updated } },
    });
    const restored = decodeServerSettings(
      JSON.parse(JSON.stringify(encodeServerSettings(settings))),
    );
    const resolved = resolveProjectSettings(restored, projectId);
    const context = agentPreferenceContext(resolved.settings.agentPreferences, threadId, "project");
    expect(context).toContain("Use detailed English answers.");
    expect(context).toContain("message:correction");
    expect(context).not.toContain("Use short German paragraphs.");
    expect(resolved.settings.agentPreferences[0]?.replaces).toEqual({
      text: preference.text,
      source: preference.source,
    });
    expect(agentPreferenceContext(restored.agentPreferences, threadId, "environment")).toContain(
      "Use short German paragraphs.",
    );
    const corrected = applyServerSettingsPatch(restored, {
      agentPreferences: [{ ...preference, text: "Use one sentence.", source: "message:latest" }],
    });
    expect(corrected.agentPreferences[0]?.replaces).toEqual({
      text: preference.text,
      source: preference.source,
    });
    const disabled = applyServerSettingsPatch(corrected, {
      agentPreferences: corrected.agentPreferences.map((entry) => ({
        ...entry,
        status: "inactive",
      })),
    });
    expect(disabled.agentPreferences[0]?.replaces).toEqual(corrected.agentPreferences[0]?.replaces);
    expect(
      agentPreferenceContext(disabled.agentPreferences, threadId, "environment"),
    ).not.toContain("Use one sentence.");
  });

  it("keeps pauses and build choices on their thread and omits completed and inactive entries", () => {
    const task = {
      ...preference,
      key: "build-location",
      text: "Use Boat for this task.",
      appliesTo: { kind: "task" as const, threadId },
    };
    const entries = [
      task,
      { ...task, key: "pause", text: "Pause this task.", status: "inactive" as const },
      { ...task, key: "recovery", text: "Publish the recovery.", status: "completed" as const },
    ];
    expect(agentPreferenceContext(entries, threadId, "environment")).toContain(task.text);
    const nextThread = agentPreferenceContext(entries, ThreadId.make("thread:next"), "environment");
    expect(nextThread).not.toContain(task.text);
    expect(nextThread).not.toContain("Pause this task.");
    expect(nextThread).not.toContain("Publish the recovery.");
    expect(nextThread).toContain("[]");
  });

  it("rejects unbounded lists, duplicate topics and task decisions without a thread", () => {
    const accepts = Schema.is(AgentPreferences);
    expect(
      accepts(Array.from({ length: 9 }, (_, index) => ({ ...preference, key: String(index) }))),
    ).toBe(false);
    expect(accepts([preference, preference])).toBe(false);
    expect(accepts([{ ...preference, appliesTo: { kind: "task" } }])).toBe(false);
    expect(accepts([{ ...preference, source: "" }])).toBe(false);
    expect(accepts([{ ...preference, text: "x".repeat(501) }])).toBe(false);
  });

  it("preserves native goal and compaction controls while attachments remain ordinary prompts", () => {
    for (const text of [
      "/compact",
      "/goal",
      "/goal pause",
      "/goal resume",
      "/goal Ship the feature",
    ]) {
      expect(
        agentPreferencePrompt({
          entries: [preference],
          threadId,
          scope: "project",
          message: { text },
        }),
      ).toBe(text);
    }
    expect(
      agentPreferencePrompt({
        entries: [preference],
        threadId,
        scope: "project",
        message: { text: "/compact", attachments: ["file"] },
      }),
    ).toContain(preference.text);
  });
});

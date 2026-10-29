import { describe, expect, it } from "vite-plus/test";
import {
  AGENT_IDENTITY_THEMES,
  AGENT_IDENTITY_THEME_OPTIONS,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { deriveAgentIdentity, resolveAgentProjectColor } from "./agentIdentity.ts";

const ref = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

describe("agent identity", () => {
  it("uses the actual scoped identity across clients, independently of titles and runs", () => {
    const firstView = { ...ref, title: "Feature one", runId: "run-1" };
    const otherClient = { ...ref, title: "Renamed feature", runId: "run-2" };
    expect(deriveAgentIdentity(firstView)).toEqual(deriveAgentIdentity(otherClient));
    expect(deriveAgentIdentity(ref).icon).toBe("agent");
    expect(deriveAgentIdentity(ref).name).not.toContain("Wiesel");
    expect(deriveAgentIdentity(ref).name).toBe("Pip Erlenholz");
  });

  it("distinguishes threads and environments without depending on which peers are loaded", () => {
    const refs = [
      ref,
      { ...ref, threadId: ThreadId.make("thread-b") },
      { ...ref, environmentId: EnvironmentId.make("environment-b") },
    ];
    for (const { value: theme } of AGENT_IDENTITY_THEME_OPTIONS) {
      const keys = refs.map((candidate) => deriveAgentIdentity(candidate, null, theme).key);
      expect(new Set(keys).size).toBe(refs.length);
    }
  });

  it("keeps lineage roles separate from theme and identity", () => {
    const child = deriveAgentIdentity(ref, { relationshipToParent: "subagent" }, "weasel");
    const neutral = deriveAgentIdentity(ref, { relationshipToParent: "subagent" });
    expect(child.role).toBe("Subagent");
    expect(child.key).toBe(neutral.key);
    expect(child.name).not.toBe(neutral.name);
    expect(child.icon).toBe("weasel");
    expect(child.avatarVariant).toBe(neutral.avatarVariant);
    expect(child.key).not.toBe(
      deriveAgentIdentity({ ...ref, threadId: ThreadId.make("thread-b") }, null, "weasel").key,
    );
    expect(deriveAgentIdentity(ref, { relationshipToParent: "fork" }).role).toBe("Fork-Agent");
  });

  it("uses deterministic theme names and keeps the technical reference out of the label", () => {
    for (const { value: theme } of AGENT_IDENTITY_THEME_OPTIONS) {
      const identity = deriveAgentIdentity(ref, { relationshipToParent: null }, theme);
      expect(identity.name).toMatch(/^[\p{Lu}][\p{Ll}]+ [\p{Lu}][\p{Ll}]+$/u);
      const endings = AGENT_IDENTITY_THEMES[theme].nameEndings;
      if (endings) expect(endings).toContain(identity.name.split(" ")[1]);
      expect(identity.label).toBe(identity.name);
      expect(identity.label).not.toContain(identity.discriminator);
      expect(identity.key).toBe(JSON.stringify([ref.environmentId, ref.threadId]));
    }
  });

  it("honors manual names without changing scoped identity or portrait", () => {
    const original = deriveAgentIdentity(ref);
    for (const { value: theme } of AGENT_IDENTITY_THEME_OPTIONS) {
      const named = deriveAgentIdentity(ref, null, theme, "  Custom companion  ");
      expect(named.name).toBe("Custom companion");
      expect(named.label).toBe(named.name);
      expect(named.key).toBe(original.key);
      expect(named.discriminator).toBe(original.discriminator);
      expect(named.avatarVariant).toBe(original.avatarVariant);
      expect(deriveAgentIdentity(ref, null, theme, null)).toEqual(
        deriveAgentIdentity(ref, null, theme),
      );
    }
  });

  it("retains its portrait when a thread becomes a child or fork", () => {
    const identity = deriveAgentIdentity(ref);
    for (const relationshipToParent of [null, "subagent", "fork"] as const) {
      for (const { value: theme } of AGENT_IDENTITY_THEME_OPTIONS) {
        const otherView = deriveAgentIdentity(ref, { relationshipToParent }, theme);
        expect(otherView).toEqual({
          ...identity,
          name: deriveAgentIdentity(ref, null, theme).name,
          label: deriveAgentIdentity(ref, null, theme).label,
          role: otherView.role,
          icon: theme === "neutral" ? "agent" : theme,
        });
        expect(otherView.avatarVariant).toBeGreaterThanOrEqual(0);
        expect(otherView.avatarVariant).toBeLessThan(4);
      }
    }
  });
});

describe("agent avatar project frame", () => {
  it("uses the loaded project's saved color rather than the agent hash", () => {
    expect(
      resolveAgentProjectColor({
        title: "T3 Code",
        projectIcon: { kind: "monogram", text: "T3", color: "emerald" },
      }),
    ).toBe("#10b981");
    expect(
      resolveAgentProjectColor({
        title: "A renamed project",
        projectIcon: { kind: "lucide", name: "folder", color: "emerald" },
      }),
    ).toBe("#10b981");
  });

  it("uses the default project icon color when no color override exists", () => {
    expect(resolveAgentProjectColor({ title: "T3 Code" })).toBe("#ec4899");
    expect(
      resolveAgentProjectColor({
        title: "  T3 CODE  ",
        projectIcon: { kind: "emoji", emoji: "🦦" },
      }),
    ).toBe(resolveAgentProjectColor({ title: "T3 Code" }));
    expect(resolveAgentProjectColor(null)).toBe("#6b7280");
  });
});

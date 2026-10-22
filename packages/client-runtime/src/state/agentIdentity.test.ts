import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
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
    for (const theme of ["neutral", "weasel"] as const) {
      const names = refs.map((candidate) => deriveAgentIdentity(candidate, null, theme).name);
      expect(new Set(names).size).toBe(refs.length);
    }
  });

  it("keeps lineage roles separate from theme and identity", () => {
    const child = deriveAgentIdentity(ref, { relationshipToParent: "subagent" }, "weasel");
    const neutral = deriveAgentIdentity(ref, { relationshipToParent: "subagent" });
    expect(child.role).toBe("Subagent");
    expect(child.key).toBe(neutral.key);
    expect(child.name).toBe(neutral.name);
    expect(child.icon).toBe("weasel");
    expect(child.avatarVariant).toBe(neutral.avatarVariant);
    expect(child.name).not.toBe(
      deriveAgentIdentity({ ...ref, threadId: ThreadId.make("thread-b") }, null, "weasel").name,
    );
    expect(deriveAgentIdentity(ref, { relationshipToParent: "fork" }).role).toBe("Fork-Agent");
  });

  it("uses a human name in both styles and keeps the technical reference out of the label", () => {
    for (const theme of ["neutral", "weasel"] as const) {
      const identity = deriveAgentIdentity(ref, { relationshipToParent: null }, theme);
      expect(identity.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
      expect(identity.label).toBe(identity.name);
      expect(identity.label).not.toContain(identity.discriminator);
      expect(identity.key).toBe(JSON.stringify([ref.environmentId, ref.threadId]));
    }
  });

  it("retains its portrait when a thread becomes a child or fork", () => {
    const identity = deriveAgentIdentity(ref);
    for (const relationshipToParent of [null, "subagent", "fork"] as const) {
      for (const theme of ["neutral", "weasel"] as const) {
        const otherView = deriveAgentIdentity(ref, { relationshipToParent }, theme);
        expect(otherView.avatarVariant).toBe(identity.avatarVariant);
        expect(otherView.name).toBe(identity.name);
        expect(otherView.label).toBe(identity.name);
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

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { deriveAgentIdentity } from "./agentIdentity.ts";

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
    expect(child.name).not.toBe(
      deriveAgentIdentity({ ...ref, threadId: ThreadId.make("thread-b") }, null, "weasel").name,
    );
    expect(deriveAgentIdentity(ref, { relationshipToParent: "fork" }).role).toBe("Fork-Agent");
  });

  it("uses a human name in both styles and keeps the technical reference out of the label", () => {
    for (const theme of ["neutral", "weasel"] as const) {
      const identity = deriveAgentIdentity(ref, { relationshipToParent: null }, theme);
      expect(identity.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/u);
      expect(identity.label).toBe(`${identity.name} · Hauptagent`);
      expect(identity.label).not.toContain(identity.discriminator);
      expect(identity.key).toBe(JSON.stringify([ref.environmentId, ref.threadId]));
    }
  });
});

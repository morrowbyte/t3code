import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildAgentMessageContext, deriveAgentIdentity } from "./agentIdentity.ts";

const ref = {
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make("thread-a"),
};

describe("agent message context", () => {
  it("omits the profile when personality is disabled", () => {
    expect(buildAgentMessageContext(ref, { theme: "fox", enabled: false })).toBeNull();
  });

  it("reuses a compact deterministic profile and respects names and environment boundaries", () => {
    const settings = { theme: "fox", enabled: true, name: 'A "quoted" companion' } as const;
    const context = buildAgentMessageContext(ref, settings);
    const identity = deriveAgentIdentity(ref, null, "fox", settings.name);
    expect(context).toBe(buildAgentMessageContext(ref, settings));
    expect(context).toContain(JSON.stringify(identity.name));
    expect(context).toContain(identity.discriminator);
    expect(context?.length).toBeLessThan(2_000);
    expect(
      buildAgentMessageContext(
        { ...ref, environmentId: EnvironmentId.make("environment-b") },
        settings,
      ),
    ).not.toBe(context);
    expect(buildAgentMessageContext(ref, { ...settings, name: null })).not.toBe(context);
  });
});

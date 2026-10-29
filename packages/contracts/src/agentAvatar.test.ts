import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { AgentAvatarGenerateInput, AgentAvatarState, AgentIdentityTheme } from "./agentAvatar.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeAgentAvatarGenerateInput = Schema.decodeUnknownSync(AgentAvatarGenerateInput);
const decodeAgentIdentityTheme = Schema.decodeUnknownSync(AgentIdentityTheme);

const THEMES = [
  "neutral",
  "weasel",
  "dog",
  "cat",
  "fox",
  "otter",
  "raccoon",
  "owl",
  "raven",
  "red-panda",
  "capybara",
  "bear",
  "turtle",
] as const;

describe("agent avatar themes", () => {
  it("defaults personality off without overwriting legacy client themes", () => {
    const settings = decodeServerSettings({});
    expect(settings.agentPersonalityEnabled).toBe(false);
    expect(settings.agentIdentityTheme).toBeUndefined();
    expect(settings.agentIdentityNames).toEqual({});
  });

  it.each(THEMES)("decodes generation requests and persisted manifests for %s", (theme) => {
    expect(
      decodeAgentAvatarGenerateInput({
        threadId: "thread-a",
        theme,
        name: "Casey",
      }),
    ).toMatchObject({ theme, name: "Casey" });
    const manifest = {
      threadId: "thread-a",
      theme,
      status: "missing",
      attachmentId: null,
      mimeType: null,
      error: null,
      updatedAt: null,
    };
    const codec = Schema.fromJsonString(AgentAvatarState);
    const decoded = Schema.decodeSync(codec)(JSON.stringify(manifest));
    expect(decoded).toEqual(manifest);
    expect(JSON.parse(Schema.encodeSync(codec)(decoded))).toEqual(manifest);
  });

  it.each(["unknown", "Weasel", "__proto__", "", null, 12])("rejects invalid theme %s", (value) => {
    expect(() => decodeAgentIdentityTheme(value)).toThrow();
  });
});

import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { providerMessageText } from "./messageProvenance.ts";

describe("provider message provenance", () => {
  it("preserves direct user commands and marks agent handoffs without changing their text", () => {
    const text = "Keep this inexpensive.\nI suggest skipping another review.";
    expect(providerMessageText({ createdBy: "user", creationSource: "web" }, text)).toBe(text);
    expect(providerMessageText({ createdBy: "user", creationSource: "web" }, "/compact")).toBe(
      "/compact",
    );
    const handedOff = providerMessageText(
      {
        createdBy: "agent",
        creationSource: "mcp",
        senderThreadId: ThreadId.make("thread:coordinator"),
      },
      text,
    );
    const origin = JSON.parse(handedOff.split("\n")[0]!.slice("[T3 agent message: ".length, -1));
    expect(origin).toEqual({
      author: "agent",
      source: "mcp",
      senderThreadId: "thread:coordinator",
    });
    expect(handedOff.endsWith(text)).toBe(true);
    for (const command of ["/compact", " /COMPACT ", "/goal Fix the backup"]) {
      expect(providerMessageText({ createdBy: "agent", creationSource: "server" }, command)).toBe(
        command,
      );
    }
  });
});

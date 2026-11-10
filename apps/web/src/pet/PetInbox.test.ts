import { describe, expect, it } from "@effect/vitest";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { PetInbox, type PetCandidate } from "./PetInbox";

const candidate = (
  key: string,
  kind: PetCandidate["kind"],
  publicText?: string,
  threadNumber = 1,
): PetCandidate => ({
  key,
  kind,
  publicText,
  threadNumber,
  ref: { environmentId: "environment" as EnvironmentId, threadId: key as ThreadId },
});
describe("pet inbox", () => {
  it("prioritizes requests across threads, bounds the projection and does not leak identities", () => {
    let next = 0;
    const inbox = new PetInbox(() => `opaque-${++next}`);
    const candidates = [
      ...Array.from({ length: 25 }, (_, index) => candidate(`private-title-${index}`, "result")),
      candidate("secret-approval", "approval"),
      candidate("secret-question", "question", "Should I use the light or dark theme?", 2),
    ];
    const result = inbox.update(candidates, 4)!;
    expect(result.items).toHaveLength(20);
    expect(result.items.slice(0, 2).map((item) => item.kind)).toEqual(["approval", "question"]);
    expect(result.items[1]?.summary).toBe(
      "Thread 2 · Question: Should I use the light or dark theme?",
    );
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("private-title");
    expect(inbox.update(candidates, 4)).toBeNull();
  });
  it("deduplicates identity, removes stale actions and preserves dismissals through reconnect", () => {
    let next = 0;
    const inbox = new PetInbox(() => `opaque-${++next}`);
    const approval = candidate("approval", "approval");
    const first = inbox.update([approval, approval], 0)!;
    expect(first.items).toHaveLength(1);
    const id = first.items[0]!.id;
    const revised = { ...approval, publicText: "Tool arguments must never be projected" };
    expect(inbox.update([revised], 0)).toBeNull();
    inbox.dismiss(id);
    expect(inbox.update([approval], 0)!.items).toEqual([]);
    inbox.update([], 0, new Set(["environment"]));
    expect(inbox.resolve(id)).toBeUndefined();
    expect(inbox.update([approval], 0)).toBeNull();
    inbox.update([], 0);
    const newer = inbox.update([candidate("new-approval", "approval")], 0)!;
    expect(newer.items[0]!.id).not.toBe(id);
    expect(inbox.resolve(id)).toBeUndefined();
  });
  it("projects bounded published prose while withholding sensitive content", () => {
    let next = 0;
    const inbox = new PetInbox(() => `opaque-${++next}`);
    const result = candidate(
      "answer",
      "result",
      "**Theme updated.** [Open settings](https://example.test/auth?token=hidden).\n\nMore details.",
      3,
    );
    const first = inbox.update([result], 0)!.items[0]!;
    expect(first.summary).toBe("Thread 3 · Result: Theme updated. Open settings.");
    const updated = inbox.update([{ ...result, publicText: "Checks passed." }], 0)!.items[0]!;
    expect(updated.id).toBe(first.id);
    expect(updated.summary).toBe("Thread 3 · Result: Checks passed.");
    expect(inbox.resolve(updated.id)?.ref).toEqual(result.ref);

    for (const text of [
      "The password is violet-snow.",
      "Verification code: 123456",
      "API key sk-secret-value",
      "Bearer demo-value",
      "Cookie: session=demo",
      "Access token is supplied below.\n\nprivate-value",
      "Unsafe \u202e direction",
      '```json\n{"secret":"hidden-value"}\n```',
    ]) {
      const item = inbox.update([{ ...result, publicText: text }], 0)?.items[0];
      if (item) expect(item.summary).toBe("Thread 3 · An agent has a completed response.");
    }
    const long = inbox.update([{ ...result, publicText: "A useful sentence. ".repeat(50) }], 0)!;
    expect(long.items[0]!.summary.length).toBeLessThanOrEqual(240);
    expect(long.items[0]!.summary).toContain("A useful sentence.");
  });
  it("does not retain resolved live requests just because another environment disconnected", () => {
    let next = 0;
    const inbox = new PetInbox(() => `opaque-${++next}`);
    const approval = candidate("approval", "approval");
    const first = inbox.update([approval], 0)!.items[0]!.id;
    inbox.dismiss(first);
    inbox.update([], 0, new Set(["another-environment"]));
    const reappeared = inbox.update([approval], 0, new Set(["another-environment"]))!;
    expect(reappeared.items[0]!.id).not.toBe(first);
  });
});

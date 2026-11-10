import { describe, expect, it } from "@effect/vitest";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { PetInbox, type PetCandidate } from "./PetInbox";

const candidate = (key: string, kind: PetCandidate["kind"]): PetCandidate => ({
  key,
  kind,
  ref: { environmentId: "environment" as EnvironmentId, threadId: key as ThreadId },
});
describe("pet inbox", () => {
  it("prioritizes requests across threads, bounds the projection and does not leak identities", () => {
    let next = 0;
    const inbox = new PetInbox(() => `opaque-${++next}`);
    const candidates = [
      ...Array.from({ length: 25 }, (_, index) => candidate(`private-title-${index}`, "result")),
      candidate("secret-approval", "approval"),
      candidate("secret-question", "question"),
    ];
    const result = inbox.update(candidates, 4)!;
    expect(result.items).toHaveLength(20);
    expect(result.items.slice(0, 2).map((item) => item.kind)).toEqual(["approval", "question"]);
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

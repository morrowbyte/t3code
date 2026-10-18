import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  addCoordinationMember,
  coordinationActionBlock,
  removeCoordinationMember,
  resolveCoordinationMember,
  type CoordinationThread,
} from "./threadCoordination.ts";

const environmentId = EnvironmentId.make("local");
const thread = (id: string): CoordinationThread => ({
  environmentId,
  id: ThreadId.make(id),
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  archivedAt: null,
  deletedAt: null,
  snoozedUntil: null,
  goal: null,
});
const coordinator = thread("coordinator");
const a = thread("a");
const b = thread("b");

describe("local thread coordination", () => {
  it("adds two originals, deduplicates, reloads and removes only the relation", () => {
    const originals = structuredClone([coordinator, a, b]);
    let members = addCoordinationMember([], coordinator, a);
    members = addCoordinationMember(members, coordinator, b);
    expect(addCoordinationMember(members, coordinator, a)).toBe(members);
    const reloaded: string[] = JSON.parse(JSON.stringify(members));
    expect(reloaded).toEqual(["a", "b"]);
    expect(removeCoordinationMember(reloaded, "a")).toEqual(["b"]);
    expect([coordinator, a, b]).toEqual(originals);
  });

  it("resolves exactly the selected original and rejects foreign, child and stale membership", () => {
    const input = { coordinator, members: [a.id, b.id], selectedId: b.id, threads: [a, b] };
    expect(resolveCoordinationMember(input)).toBe(b);
    expect(resolveCoordinationMember({ ...input, members: [a.id] })).toBeNull();
    expect(resolveCoordinationMember({ ...input, selectedId: coordinator.id })).toBeNull();
    for (const invalid of [
      { ...b, environmentId: EnvironmentId.make("foreign") },
      {
        ...b,
        lineage: { ...b.lineage, parentThreadId: a.id, relationshipToParent: "subagent" as const },
      },
      { ...b, deletedAt: "2026-10-19" },
    ]) {
      expect(addCoordinationMember([], coordinator, invalid)).toEqual([]);
      expect(resolveCoordinationMember({ ...input, threads: [invalid] })).toBeNull();
    }
    expect(addCoordinationMember([], coordinator, coordinator)).toEqual([]);
  });

  it("fails closed for read-only, archived, paused, snoozed, held and stale state", () => {
    const input = { coordinator, target: a, allowed: true, detailLive: true, queueHeld: false };
    expect(coordinationActionBlock(input)).toBeNull();
    expect(coordinationActionBlock({ ...input, allowed: false })).toContain("read-only");
    expect(coordinationActionBlock({ ...input, detailLive: false })).toContain("current");
    expect(coordinationActionBlock({ ...input, queueHeld: true })).toContain("paused");
    expect(coordinationActionBlock({ ...input, target: null })).toContain("Select");
    for (const protectedThread of [
      { ...a, archivedAt: "2026-10-19" },
      { ...a, snoozedUntil: "2026-10-20" },
      { ...a, goal: { status: "paused" } as NonNullable<CoordinationThread["goal"]> },
    ]) {
      expect(coordinationActionBlock({ ...input, target: protectedThread })).not.toBeNull();
      expect(coordinationActionBlock({ ...input, coordinator: protectedThread })).not.toBeNull();
    }
  });
});

import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createDescendantThreadRequestsAtom,
  selectDescendantRequestOrigins,
} from "./descendantThreadRequests.ts";
import { threadKey } from "./entities.ts";
import { v2Now, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import type { PendingThreadRequests } from "./threadRequests.ts";
import type { EnvironmentThreadStatus } from "./threadState.ts";

const environmentId = EnvironmentId.make("descendant-requests");
const rootId = ThreadId.make("root");
const emptyRequests: PendingThreadRequests = { approvals: [], userInputs: [] };

function shell(
  id: string,
  parentId: string | null = null,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  return {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: id,
    creationSource: "mcp",
    lineage: {
      rootThreadId: rootId,
      parentThreadId: parentId === null ? null : ThreadId.make(parentId),
      relationshipToParent: parentId === null ? null : "subagent",
    },
    ...overrides,
  };
}

function waitingShell(
  id: string,
  parentId: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
) {
  return shell(id, parentId, {
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`request:${id}`),
      kind: "user_input",
      createdAt: v2Now,
    },
    ...overrides,
  });
}

function questions(...ids: string[]): PendingThreadRequests {
  return {
    approvals: [],
    userInputs: ids.map((id) => ({
      requestId: RuntimeRequestId.make(id),
      createdAt: DateTime.formatIso(v2Now),
      responseCapability: "message",
      responseMode: "message",
      dismissible: true,
      questions: [
        {
          id: `question:${id}`,
          header: "Choice",
          question: "Which option?",
          options: [],
          multiSelect: false,
        },
      ],
    })),
  };
}

const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries) registry.dispose();
  registries.length = 0;
});

function harness(threads: ReadonlyArray<OrchestrationV2ThreadShell>) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const threadsAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(threads));
  const pendingAtom = Atom.family((_key: string) => Atom.make<PendingThreadRequests | null>(null));
  const statusAtom = Atom.family((_key: string) => Atom.make<EnvironmentThreadStatus>("live"));
  const reads = new Set<string>();
  const descendants = createDescendantThreadRequestsAtom({
    threadsAtom,
    pendingRequestsAtom: (ref) => {
      reads.add(threadKey(ref));
      return pendingAtom(threadKey(ref));
    },
    statusAtom: (ref) => statusAtom(threadKey(ref)),
  });
  const ref = (id: string, environment = environmentId): ScopedThreadRef => ({
    environmentId: environment,
    threadId: ThreadId.make(id),
  });
  const root = descendants(ref("root"));
  registry.mount(root);
  return { registry, threadsAtom, pendingAtom, statusAtom, descendants, reads, ref, root };
}

describe("descendant request origins", () => {
  it("exposes one original grandchild in every ancestor through subagent and fork edges", () => {
    const child = shell("child", "root");
    const grandchild = waitingShell("grandchild", "child", {
      lineage: {
        rootThreadId: rootId,
        parentThreadId: child.id,
        relationshipToParent: "fork",
      },
    });
    const threads = [shell("root"), child, grandchild, waitingShell("other", "unrelated")];
    expect(selectDescendantRequestOrigins(threads, rootId)).toEqual([grandchild]);
    expect(selectDescendantRequestOrigins(threads, child.id)).toEqual([grandchild]);
    expect(selectDescendantRequestOrigins(threads, grandchild.id)).toEqual([]);
  });

  it("deduplicates origins and terminates cycles without inventing missing ancestry", () => {
    const child = waitingShell("child", "root");
    const cycleA = waitingShell("cycle-a", "cycle-b");
    const cycleB = waitingShell("cycle-b", "cycle-a");
    const missing = waitingShell("missing", "unknown");
    const detached = waitingShell("detached", "root", {
      lineage: { rootThreadId: rootId, parentThreadId: rootId, relationshipToParent: null },
    });
    expect(
      selectDescendantRequestOrigins(
        [shell("root"), child, child, cycleA, cycleB, missing, detached],
        rootId,
      ),
    ).toEqual([child]);
  });

  it("retains stopped questions and inspects origins while excluding native mirrors", () => {
    const stopped = waitingShell("stopped", "root", {
      status: "completed",
      activityRunStatus: null,
    });
    const mirror = waitingShell("mirror", "root", { creationSource: "provider" });
    const auth = waitingShell("auth", "root", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("auth"),
        kind: "auth_refresh",
        createdAt: v2Now,
      },
    });
    const tool = waitingShell("tool", "root", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("tool"),
        kind: "dynamic_tool_call",
        createdAt: v2Now,
      },
    });
    const deleted = waitingShell("deleted", "root", { deletedAt: v2Now });
    expect(
      selectDescendantRequestOrigins([shell("root"), stopped, mirror, auth, tool, deleted], rootId),
    ).toEqual([stopped, auth, tool]);
  });
});

describe("descendant request atoms", () => {
  it("finds older supported questions when the newest shell request has a different kind", () => {
    const child = waitingShell("child", "root", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("newer-auth"),
        kind: "auth_refresh",
        createdAt: v2Now,
      },
    });
    const h = harness([shell("root"), child]);
    const pending = h.pendingAtom(threadKey(h.ref("child")));
    h.registry.set(pending, questions("older-question"));
    expect(h.registry.get(h.root)[0]?.requests?.userInputs[0]?.requestId).toBe("older-question");
    h.registry.set(pending, emptyRequests);
    expect(h.registry.get(h.root)).toEqual([]);
  });
  it("subscribes only genuine waiting origins and preserves all original requests", () => {
    const h = harness([
      shell("root"),
      shell("child", "root"),
      waitingShell("grandchild", "child"),
      waitingShell("unrelated", "elsewhere"),
    ]);
    const origin = h.ref("grandchild");
    const requests: PendingThreadRequests = {
      ...questions("first", "second"),
      approvals: [
        {
          requestId: RuntimeRequestId.make("permission"),
          requestKind: "command",
          createdAt: DateTime.formatIso(v2Now),
          detail: "Allow this command?",
          responseCapability: "live",
        },
      ],
    };
    h.registry.set(h.pendingAtom(threadKey(origin)), requests);
    const parentGroups = h.registry.get(h.root);
    const childGroups = h.registry.get(h.descendants(h.ref("child")));
    expect(parentGroups[0]?.origin).toEqual(origin);
    expect(parentGroups[0]?.requests).toBe(requests);
    expect(childGroups[0]?.origin).toEqual(origin);
    expect(childGroups[0]?.requests).toBe(requests);
    expect(h.reads).toEqual(new Set([threadKey(origin)]));
  });

  it("removes answered or cancelled requests from both ancestor views before the shell catches up", () => {
    const h = harness([shell("root"), shell("child", "root"), waitingShell("grandchild", "child")]);
    const source = h.pendingAtom(threadKey(h.ref("grandchild")));
    const childView = h.descendants(h.ref("child"));
    h.registry.mount(childView);
    h.registry.set(source, questions("original"));
    expect(h.registry.get(h.root)).toHaveLength(1);
    expect(h.registry.get(childView)).toHaveLength(1);
    h.registry.set(source, emptyRequests);
    expect(h.registry.get(h.root)).toEqual([]);
    expect(h.registry.get(childView)).toEqual([]);
  });

  it("drops a cancelled shell and a deleted origin without retaining cached request cards", () => {
    const child = waitingShell("child", "root");
    const h = harness([shell("root"), child]);
    const origin = h.ref("child");
    h.registry.set(h.pendingAtom(threadKey(origin)), questions("original"));
    expect(h.registry.get(h.root)).toHaveLength(1);
    h.registry.set(h.statusAtom(threadKey(origin)), "deleted");
    expect(h.registry.get(h.root)).toEqual([]);
    h.registry.set(h.statusAtom(threadKey(origin)), "live");
    h.registry.set(h.threadsAtom(environmentId), [
      shell("root"),
      { ...child, pendingRuntimeRequest: null },
    ]);
    expect(h.registry.get(h.root)).toEqual([]);
  });

  it("hides cached question content until live reconciliation and retains original identity", () => {
    const h = harness([shell("root"), waitingShell("child", "root")]);
    const key = threadKey(h.ref("child"));
    const requests = questions("original");
    h.registry.set(h.pendingAtom(key), requests);
    const live = h.registry.get(h.root)[0]!;
    for (const status of ["cached", "synchronizing"] as const) {
      h.registry.set(h.statusAtom(key), status);
      const loading = h.registry.get(h.root)[0]!;
      expect(loading.origin).toBe(live.origin);
      expect(loading.status).toBe(status);
      expect(loading.requests).toBeNull();
    }
    h.registry.set(h.statusAtom(key), "live");
    const resumed = h.registry.get(h.root)[0]!;
    expect(resumed.origin).toBe(live.origin);
    expect(resumed.requests).toBe(requests);
    expect(resumed.requests?.userInputs[0]?.requestId).toBe(RuntimeRequestId.make("original"));
    h.registry.set(h.statusAtom(key), "synchronizing");
    h.registry.set(h.pendingAtom(key), emptyRequests);
    h.registry.set(h.statusAtom(key), "live");
    expect(h.registry.get(h.root)).toEqual([]);
  });

  it("keeps an uncached request loading and updates the same origin when details arrive", () => {
    const h = harness([shell("root"), waitingShell("child", "root")]);
    const origin = h.registry.get(h.root)[0]!.origin;
    expect(h.registry.get(h.root)[0]?.requests).toBeNull();
    h.registry.set(h.pendingAtom(threadKey(origin)), questions("original"));
    expect(h.registry.get(h.root)[0]?.origin).toBe(origin);
    expect(h.registry.get(h.root)[0]?.requests?.userInputs[0]?.requestId).toBe("original");
  });

  it("isolates identical thread and request IDs in different environments", () => {
    const h = harness([shell("root"), waitingShell("child", "root")]);
    const remote = EnvironmentId.make("other-environment");
    const localOrigin = h.ref("child");
    const remoteOrigin = h.ref("child", remote);
    const localRequests = questions("same-id");
    const remoteRequests = questions("same-id");
    h.registry.set(h.pendingAtom(threadKey(localOrigin)), localRequests);
    h.registry.set(h.pendingAtom(threadKey(remoteOrigin)), remoteRequests);
    const remoteView = h.descendants(h.ref("root", remote));
    h.registry.mount(remoteView);
    expect(h.registry.get(h.root)[0]?.origin).toEqual(localOrigin);
    expect(h.registry.get(remoteView)[0]?.origin).toEqual(remoteOrigin);
    expect(h.registry.get(h.root)[0]?.requests).toBe(localRequests);
    expect(h.registry.get(remoteView)[0]?.requests).toBe(remoteRequests);
    h.registry.set(h.pendingAtom(threadKey(remoteOrigin)), emptyRequests);
    expect(h.registry.get(remoteView)).toEqual([]);
    expect(h.registry.get(h.root)[0]?.requests).toBe(localRequests);
    expect(h.descendants(h.ref("root"))).toBe(h.root);
  });

  it("keeps arrays and unaffected groups stable while other chat content streams", () => {
    const first = waitingShell("first", "root");
    const second = waitingShell("second", "root");
    const h = harness([shell("root"), first, second]);
    h.registry.set(h.pendingAtom(threadKey(h.ref("first"))), questions("first"));
    h.registry.set(h.pendingAtom(threadKey(h.ref("second"))), questions("second"));
    const before = h.registry.get(h.root);
    const streamed = { ...first, itemCount: 99, updatedAt: DateTime.add(v2Now, { seconds: 1 }) };
    h.registry.set(h.threadsAtom(environmentId), [shell("root"), streamed, second]);
    expect(h.registry.get(h.root)).toBe(before);
    h.registry.set(h.threadsAtom(environmentId), [
      shell("root"),
      {
        ...streamed,
        title: "Updated title",
        runtimeMode: "approval-required",
        worktreePath: "/new/path",
      },
      second,
    ]);
    const updated = h.registry.get(h.root);
    expect(updated).not.toBe(before);
    expect(updated[0]).toMatchObject({
      title: "Updated title",
      runtimeMode: "approval-required",
      worktreePath: "/new/path",
    });
    expect(updated[0]?.origin).toBe(before[0]?.origin);
    expect(updated[1]).toBe(before[1]);
  });
});

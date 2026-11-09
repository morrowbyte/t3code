import { ProjectId, ThreadId, type BoatInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { boatRuntimeLabel, selectThreadBoats } from "./threadDetailsBoat";

const projectId = ProjectId.make("project");
const instance = (overrides: Partial<BoatInstance> = {}): BoatInstance => ({
  requestId: "machine",
  projectId,
  sandboxId: "sandbox",
  threadId: null,
  leases: [],
  stoppedAt: null,
  previewTabId: null,
  size: "default",
  state: "running",
  createdAt: "2026-10-30T00:00:00Z",
  expiresAt: "2026-10-30T01:00:00Z",
  costUsd: 0.036,
  snapshot: "",
  savedSnapshot: null,
  processId: null,
  deletionOperationId: null,
  output: "",
  previewUrl: null,
  ...overrides,
});

describe("selectThreadBoats", () => {
  it("lists only machines owned by this thread, including retained stopped machines", () => {
    const threadId = ThreadId.make("first");
    const selected = selectThreadBoats(
      [
        instance({ requestId: "stopped", state: "stopped", threadId }),
        instance({ requestId: "owned", threadId }),
        instance({
          requestId: "other-owner",
          threadId: ThreadId.make("second"),
          leases: [threadId],
        }),
        instance(),
        instance({ requestId: "deleted", state: "deleted", threadId }),
        instance({ requestId: "other-project", projectId: ProjectId.make("other"), threadId }),
      ],
      projectId,
      threadId,
    );
    expect(selected.map((boat) => boat.requestId)).toEqual(["owned", "stopped"]);
  });

  it("keeps provisioning machines visible before a sandbox ID is assigned", () => {
    const threadId = ThreadId.make("first");
    const pending = instance({ threadId, state: "provisioning", sandboxId: null });
    expect(selectThreadBoats([pending], projectId, threadId)).toEqual([pending]);
    expect(selectThreadBoats([], projectId, threadId)).toEqual([]);
  });
});

describe("boatRuntimeLabel", () => {
  it("shows the remaining deadline without claiming an expired machine has stopped", () => {
    const now = Date.parse("2026-10-30T00:30:00Z");
    expect(boatRuntimeLabel(instance(), now)).toBe("30 min left");
    expect(boatRuntimeLabel(instance(), now + 30 * 60000)).toBe("Runtime ended");
    expect(boatRuntimeLabel(instance({ expiresAt: "unknown" }), now)).toBe("Runtime unknown");
    expect(boatRuntimeLabel(instance({ state: "stopped" }), now)).toBeNull();
    expect(boatRuntimeLabel(instance({ state: "archived" }), now)).toBeNull();
  });
});

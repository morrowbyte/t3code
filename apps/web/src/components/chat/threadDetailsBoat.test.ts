import { ProjectId, ThreadId, type BoatInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { summarizeProjectBoat } from "./threadDetailsBoat";

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

describe("summarizeProjectBoat", () => {
  it("counts actual sizes across project threads and excludes other projects", () => {
    const summary = summarizeProjectBoat(
      [
        instance({ size: "small", threadId: ThreadId.make("first"), costUsd: 0.018 }),
        instance({ size: "large", threadId: ThreadId.make("second"), costUsd: 0.072 }),
        instance({ size: "xlarge", costUsd: 0.2 }),
        instance(),
        instance({ projectId: ProjectId.make("other"), costUsd: 100 }),
      ],
      projectId,
    );
    expect(summary.active).toEqual({ small: 1, default: 1, large: 1, xlarge: 1 });
    expect(summary.costUsd).toBeCloseTo(0.326);
  });

  it("retains inactive VM usage without counting those VMs as active", () => {
    const states = ["running", "starting", "deleting", "archived", "stopped", "deleted", "error"];
    const summary = summarizeProjectBoat(
      states.map((state) => instance({ state })),
      projectId,
    );
    expect(summary.active).toEqual({ small: 0, default: 3, large: 0, xlarge: 0 });
    expect(summary.costUsd).toBeCloseTo(states.length * 0.036);
    expect(summarizeProjectBoat([], projectId)).toEqual({
      active: { small: 0, default: 0, large: 0, xlarge: 0 },
      costUsd: 0,
    });
  });
});

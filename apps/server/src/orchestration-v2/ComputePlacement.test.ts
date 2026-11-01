import {
  DEFAULT_BOAT_DEFAULTS,
  DEFAULT_BOAT_PROJECT,
  ProjectId,
  ThreadId,
  type BoatInstance,
  type BoatState,
  type HostResourcesSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseComputePlacement,
  computeRequestId,
  type ComputePlacementInput,
} from "./ComputePlacement.ts";

const GiB = 1024 ** 3;
const projectId = ProjectId.make("placement-project");
const ownerThreadId = ThreadId.make("placement-owner");
const requestId = "placement-request";
const healthy: HostResourcesSnapshot = {
  sampledAt: 1,
  cpuUtilization: 0.2,
  cpuCount: 8,
  availableMemoryBytes: 8 * GiB,
  totalMemoryBytes: 16 * GiB,
};

const instance = (overrides: Partial<BoatInstance> = {}): BoatInstance => ({
  requestId,
  projectId,
  threadId: ownerThreadId,
  sandboxId: "sandbox",
  leases: [],
  state: "ready",
  size: "default",
  createdAt: "2026-11-01T00:00:00Z",
  expiresAt: "2026-11-01T01:00:00Z",
  stoppedAt: null,
  costUsd: 0,
  snapshot: "",
  savedSnapshot: null,
  processId: null,
  deletionOperationId: null,
  previewTabId: null,
  previewUrl: null,
  output: "",
  ...overrides,
});

const boat = (overrides: Partial<BoatState> = {}): BoatState => ({
  defaults: DEFAULT_BOAT_DEFAULTS,
  configured: true,
  projects: { [projectId]: { ...DEFAULT_BOAT_PROJECT, enabled: true } },
  instances: [],
  account: {
    status: "ready",
    canStart: true,
    reason: null,
    remainingHours: 1,
    walletUsd: 1,
    maxConcurrent: 2,
    sizes: ["default"],
  },
  ...overrides,
});

const input = (overrides: Partial<ComputePlacementInput> = {}): ComputePlacementInput => ({
  projectId,
  ownerThreadId,
  requestId,
  resources: healthy,
  storageFailure: null,
  forceBoat: false,
  boat: boat(),
  ...overrides,
});

it("keeps request IDs bounded and scoped to the project and thread", () => {
  const longThread = ThreadId.make("t".repeat(512));
  const first = computeRequestId(projectId, longThread);
  expect(first.length).toBeLessThanOrEqual(160);
  expect(first).toBe(computeRequestId(projectId, longThread));
  expect(first).not.toBe(computeRequestId(ProjectId.make("other-project"), longThread));
  expect(first).not.toBe(computeRequestId(projectId, ThreadId.make("other-thread")));
  const legacyHash = "a".repeat(64);
  expect(computeRequestId(projectId, ThreadId.make(`work-owner:${legacyHash}:key`))).toBe(
    `work-${legacyHash}`,
  );
  expect(
    computeRequestId(projectId, ThreadId.make(`work-owner:${"a".repeat(512)}:key`)).length,
  ).toBeLessThanOrEqual(160);
});

describe("chooseComputePlacement", () => {
  it.each([null, "reserved-sandbox"])(
    "continues an owned provisioning reservation with sandbox %s",
    (sandboxId) => {
      expect(
        chooseComputePlacement(
          input({
            forceBoat: true,
            boat: boat({ instances: [instance({ state: "provisioning", sandboxId })] }),
          }),
        ),
      ).toEqual({
        target: "boat",
        reason: "forced",
        requestId,
        action: sandboxId === null ? "start" : "resume",
      });
    },
  );

  it("keeps a healthy host local without requiring Boat", () => {
    expect(chooseComputePlacement(input({ boat: null }))).toEqual({
      target: "local",
      reason: "healthy",
    });
  });

  it.each([
    [0.899, "local"],
    [0.9, "boat"],
    [1, "boat"],
  ] as const)("uses the CPU boundary at %s", (cpuUtilization, target) => {
    expect(chooseComputePlacement(input({ resources: { ...healthy, cpuUtilization } }))).toEqual(
      target === "local"
        ? { target, reason: "healthy" }
        : { target, reason: "cpu_pressure", requestId, action: "start" },
    );
  });

  it.each([
    [16 * GiB, 2 * GiB, "boat"],
    [16 * GiB, 2 * GiB + 1, "local"],
    [40 * GiB, 4 * GiB, "boat"],
    [40 * GiB, 4 * GiB + 1, "local"],
  ] as const)("uses memory headroom %s/%s", (totalMemoryBytes, availableMemoryBytes, target) => {
    expect(
      chooseComputePlacement(
        input({ resources: { ...healthy, totalMemoryBytes, availableMemoryBytes } }),
      ),
    ).toEqual(
      target === "local"
        ? { target, reason: "healthy" }
        : { target, reason: "memory_pressure", requestId, action: "start" },
    );
  });

  it.each(["ready", "idle", "running", "archived", "stopped"])(
    "reuses the preferred owned %s instance",
    (state) => {
      expect(
        chooseComputePlacement(
          input({
            resources: { ...healthy, cpuUtilization: 0.9 },
            boat: boat({
              instances: [instance({ requestId: "other-owned" }), instance({ state })],
            }),
          }),
        ),
      ).toEqual({
        target: "boat",
        reason: "cpu_pressure",
        requestId,
        action: state === "archived" || state === "stopped" ? "resume" : "renew",
      });
    },
  );

  it("prefers another owned running instance over a stopped one and a new allocation", () => {
    expect(
      chooseComputePlacement(
        input({
          forceBoat: true,
          boat: boat({
            account: null,
            instances: [
              instance({ requestId: "paused", state: "stopped" }),
              instance({ requestId: "active", state: "running" }),
            ],
          }),
        }),
      ),
    ).toEqual({ target: "boat", reason: "forced", requestId: "active", action: "renew" });
  });

  it("keeps an owned active instance usable when the account cannot start another", () => {
    const state = boat({ instances: [instance()] });
    expect(
      chooseComputePlacement(
        input({
          forceBoat: true,
          boat: { ...state, account: { ...state.account!, canStart: false } },
        }),
      ),
    ).toEqual({ target: "boat", reason: "forced", requestId, action: "renew" });
  });

  it.each([
    { threadId: ThreadId.make("another-owner"), leases: [ownerThreadId] },
    { projectId: ProjectId.make("another-project") },
    { threadId: null },
    { state: "deleted" },
    { state: "deleting" },
    { state: "error" },
    { sandboxId: null },
  ] satisfies Array<Partial<BoatInstance>>)(
    "does not reuse a foreign or unusable instance: %j",
    (overrides) => {
      expect(
        chooseComputePlacement(
          input({
            forceBoat: true,
            boat: boat({ instances: [instance({ requestId: "unusable", ...overrides })] }),
          }),
        ),
      ).toEqual({ target: "boat", reason: "forced", requestId, action: "start" });
    },
  );

  it("uses an owned alternative when the preferred ID belongs to another owner", () => {
    expect(
      chooseComputePlacement(
        input({
          forceBoat: true,
          boat: boat({
            instances: [
              instance({ threadId: ThreadId.make("another-owner") }),
              instance({ requestId: "owned-alternative" }),
            ],
          }),
        }),
      ),
    ).toEqual({
      target: "boat",
      reason: "forced",
      requestId: "owned-alternative",
      action: "renew",
    });
  });

  it.each([
    { threadId: ThreadId.make("another-owner") },
    { projectId: ProjectId.make("another-project") },
    { state: "deleted" },
  ] satisfies Array<Partial<BoatInstance>>)(
    "blocks a colliding request ID rather than rebinding it: %j",
    (overrides) => {
      expect(
        chooseComputePlacement(
          input({ forceBoat: true, boat: boat({ instances: [instance(overrides)] }) }),
        ),
      ).toEqual({ target: "blocked", reason: "boat_conflict" });
    },
  );

  it.each([
    [null, "boat_unavailable"],
    [boat({ configured: false }), "boat_unconfigured"],
    [boat({ projects: {} }), "boat_disabled"],
    [boat({ projects: { [projectId]: DEFAULT_BOAT_PROJECT } }), "boat_disabled"],
    [boat({ account: null }), "boat_capacity"],
    [boat({ account: { ...boat().account!, canStart: false } }), "boat_capacity"],
  ] as const)("blocks unavailable remote admission: %s", (state, reason) => {
    expect(chooseComputePlacement(input({ forceBoat: true, boat: state }))).toEqual({
      target: "blocked",
      reason,
    });
  });

  it.each(["storage_pressure", "storage_measurement_failed"] as const)(
    "keeps %s blocking even with forceBoat",
    (code) => {
      expect(
        chooseComputePlacement(
          input({
            forceBoat: true,
            resources: null,
            storageFailure: { code, message: "Storage gate remains closed" },
          }),
        ),
      ).toEqual({ target: "blocked", reason: code });
    },
  );

  it.each([null, { ...healthy, cpuUtilization: null }])(
    "does not call unknown resources healthy: %s",
    (resources) => {
      expect(chooseComputePlacement(input({ resources }))).toEqual({
        target: "blocked",
        reason: "resources_unavailable",
      });
      expect(chooseComputePlacement(input({ resources, forceBoat: true }))).toEqual({
        target: "boat",
        reason: "forced",
        requestId,
        action: "start",
      });
    },
  );

  it.each([
    { cpuUtilization: NaN },
    { cpuUtilization: Infinity },
    { cpuUtilization: -0.1 },
    { cpuUtilization: 1.1 },
    { cpuCount: 0 },
    { cpuCount: 1.5 },
    { availableMemoryBytes: -1 },
    { availableMemoryBytes: 17 * GiB },
    { totalMemoryBytes: 0 },
    { totalMemoryBytes: Infinity },
    { sampledAt: -1 },
  ] satisfies Array<Partial<HostResourcesSnapshot>>)(
    "rejects invalid measurements: %j",
    (overrides) => {
      const resources = { ...healthy, ...overrides };
      expect(chooseComputePlacement(input({ resources }))).toEqual({
        target: "blocked",
        reason: "resources_invalid",
      });
      expect(chooseComputePlacement(input({ resources, forceBoat: true }))).toEqual({
        target: "boat",
        reason: "forced",
        requestId,
        action: "start",
      });
    },
  );

  it("leaves final budget and project concurrency admission to BoatService", () => {
    expect(
      chooseComputePlacement(
        input({
          forceBoat: true,
          boat: boat({
            projects: {
              [projectId]: {
                ...DEFAULT_BOAT_PROJECT,
                enabled: true,
                maxConcurrent: 1,
                budgetUsd: 0.1,
              },
            },
            instances: [
              instance({
                requestId: "other",
                threadId: ThreadId.make("another-owner"),
                costUsd: 100,
              }),
            ],
          }),
        }),
      ),
    ).toEqual({ target: "boat", reason: "forced", requestId, action: "start" });
  });
});

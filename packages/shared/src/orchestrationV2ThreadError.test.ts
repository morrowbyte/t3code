import { expect, it } from "vite-plus/test";
import { type OrchestrationV2Run, ProviderInstanceId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { latestExecutedRun, latestUnheldRun } from "./orchestrationV2ThreadError.ts";

it("keeps provider resume and error history visible after a later delegation admission", () => {
  const providerRun = {
    id: RunId.make("provider-run"),
    ordinal: 1,
    status: "failed",
    startedAt: DateTime.makeUnsafe("2026-10-23T18:00:00Z"),
    completedAt: DateTime.makeUnsafe("2026-10-23T18:01:00Z"),
  } as OrchestrationV2Run;
  const admission = {
    ...providerRun,
    id: RunId.make("admission"),
    ordinal: 2,
    status: "completed" as const,
    completedAt: DateTime.makeUnsafe("2026-10-23T18:02:00Z"),
    delegationAdmission: {
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    },
  };
  expect(latestExecutedRun([providerRun, admission])).toBe(providerRun);
  expect(latestExecutedRun([admission])).toBeNull();
  expect(latestUnheldRun([providerRun, admission])).toBe(providerRun);
  expect(latestUnheldRun([admission])).toBeNull();
});

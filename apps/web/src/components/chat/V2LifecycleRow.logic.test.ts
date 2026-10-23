import { NodeId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { notificationSubagent, subagentResumedSince } from "./V2LifecycleRow.logic";

const failedAt = "2026-10-09T12:21:00.000Z";
const beforeFailure = DateTime.makeUnsafe("2026-10-09T12:05:00.000Z");
const afterFailure = DateTime.makeUnsafe("2026-10-09T12:48:00.000Z");

describe("subagentResumedSince", () => {
  it("is true while it runs even when the notification was delivered after the resume", () => {
    expect(
      subagentResumedSince(
        { status: "running", startedAt: afterFailure },
        "2026-10-09T12:50:00.000Z",
      ),
    ).toBe(true);
  });

  // regression: #18099 a resumed subagent's old failure notification row showed failed instead of resumed
  it("is true once a run started after the notification has settled", () => {
    expect(subagentResumedSince({ status: "completed", startedAt: afterFailure }, failedAt)).toBe(
      true,
    );
  });

  it("is false for the run the notification reported on", () => {
    expect(subagentResumedSince({ status: "failed", startedAt: beforeFailure }, failedAt)).toBe(
      false,
    );
  });
});

describe("notificationSubagent", () => {
  it("keeps an original task and a follow-up in the same child thread distinct", () => {
    const childThreadId = ThreadId.make("child");
    const original = { id: NodeId.make("original"), childThreadId };
    const followUp = { id: NodeId.make("follow-up"), childThreadId };
    expect(
      notificationSubagent(
        [original, followUp],
        {
          kind: "delegated_task",
          taskIds: [followUp.id],
          childThreadId,
        },
        childThreadId,
      ),
    ).toBe(followUp);
    expect(
      notificationSubagent(
        [original, followUp],
        {
          kind: "delegated_task",
          taskIds: [original.id],
          childThreadId,
        },
        childThreadId,
      ),
    ).toBe(original);
  });

  it("does not substitute another result when the notified task is missing", () => {
    const childThreadId = ThreadId.make("child");
    const original = { id: NodeId.make("original"), childThreadId };
    expect(
      notificationSubagent(
        [original],
        {
          kind: "delegated_task",
          taskIds: [NodeId.make("missing")],
          childThreadId,
        },
        childThreadId,
      ),
    ).toBeNull();
    expect(
      notificationSubagent([original], { kind: "subagent", childThreadId }, childThreadId),
    ).toBe(original);
  });
});

import {
  MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { mergeOlderHistoryIntoProjection } from "@t3tools/client-runtime/state/thread-history-merge";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import { makeThreadProjectionFixture } from "../../test-fixtures";

import {
  announcedRun,
  deliveryFailureSnapshot,
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

const idle = (
  runId: RunId | null,
  runStatus: ThreadActivitySnapshot["runStatus"],
): ThreadActivitySnapshot => ({ status: "idle", requestId: null, runId, runStatus });
const busy = (
  status: Exclude<ThreadActivitySnapshot["status"], "idle"> = "working",
  runId: RunId | null = secondRun,
  runStatus: ThreadActivitySnapshot["runStatus"] = "running",
  requestId: string | null = status === "working" ? null : "request-1",
): ThreadActivitySnapshot => ({ status, requestId, runId, runStatus });

function speak(snapshots: ReadonlyArray<ThreadActivitySnapshot>) {
  let memory: ThreadAnnouncementMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextThreadAnnouncement(memory, snapshot);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextThreadAnnouncement", () => {
  it.each(["steering-delivery-failure", "runtime-request-delivery-failure"])(
    "follows a turn through one %s announcement to its result",
    (kind) => {
      const deliveryFailure = {
        id: `turn-item:${kind}:message-1`,
        ordinal: 11,
        message: "Delivery not confirmed. Send it again if it is still needed.",
      };
      const working = { ...busy(), latestLocalItemOrdinal: 10 };
      const failed = {
        ...working,
        latestLocalItemOrdinal: 11,
        deliveryFailures: [deliveryFailure],
      };
      const batched = {
        ...working,
        latestLocalItemOrdinal: 13,
        deliveryFailures: [
          { ...deliveryFailure, id: "message-2", ordinal: 12, message: "Correction rejected" },
          { ...deliveryFailure, id: "message-3", ordinal: 13, message: "Answer rejected" },
        ],
      };
      expect(
        speak([
          idle(firstRun, "completed"),
          working,
          failed,
          failed,
          working,
          failed,
          { ...failed, deliveryFailures: [{ ...deliveryFailure, id: "historical", ordinal: 3 }] },
          failed,
          batched,
          batched,
          idle(secondRun, "completed"),
        ]),
      ).toEqual([
        "Working",
        deliveryFailure.message,
        "Correction rejected. Answer rejected",
        "Done",
      ]);
      const ended = { ...failed, ...idle(secondRun, "completed") };
      expect(speak([working, ended, ended])).toEqual([`Done. ${deliveryFailure.message}`]);
      expect(
        speak([working, { ...working, ...idle(secondRun, "completed") }, ended, ended]),
      ).toEqual(["Done", deliveryFailure.message]);
      expect(speak([ended, ended])).toEqual([]);
    },
  );

  it("says Working once when a send looks idle before its run appears", () => {
    expect(
      speak([idle(null, null), busy(), idle(null, null), busy(), idle(secondRun, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("announces a queued message that starts as the last turn ends", () => {
    const thirdRun = RunId.make("run-3");
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        busy(),
        busy("working", secondRun, "completed"),
        busy("working", thirdRun, "starting"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The last turn's run is still settling when the follow-up is sent.
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        idle(firstRun, "completed"),
        busy("working", secondRun, "starting"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    expect(
      speak([
        busy("working", firstRun, "running"),
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
  });

  it("treats a run that starts while the thread looks idle as the next turn", () => {
    const thirdRun = RunId.make("run-3");
    // A resume or a turn started from another device.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "starting"),
        busy("working", secondRun, "running"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    // A queued message waiting to start after the last turn.
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(thirdRun, "queued"),
        idle(thirdRun, "starting"),
        busy("working", thirdRun, "running"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
  });

  it("stays silent when a thread opens mid-turn or after one", () => {
    expect(speak([idle(firstRun, "completed"), idle(firstRun, "completed")])).toEqual([]);
    expect(speak([busy(), busy()])).toEqual([]);
    const initialProjection = makeThreadProjectionFixture();
    const row = (
      ordinal: number,
      position: number,
      visibility: "local" | "inherited" = "local",
    ): OrchestrationV2ProjectedTurnItem => {
      const id = TurnItemId.make(`turn-item:steering-delivery-failure:message-${ordinal}`);
      const sourceThreadId =
        visibility === "local" ? initialProjection.thread.id : ThreadId.make("other-thread");
      return {
        position,
        visibility,
        sourceThreadId,
        sourceItemId: id,
        item: {
          id,
          threadId: sourceThreadId,
          runId: secondRun,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "failed",
          title: "Correction delivery not confirmed",
          startedAt: initialProjection.updatedAt,
          completedAt: initialProjection.updatedAt,
          updatedAt: initialProjection.updatedAt,
          type: "error",
          failure: {
            class: "transport_error",
            message: "Send it again if needed.",
            code: null,
            retryable: null,
          },
        },
      };
    };
    const historicalFailure = row(100, 0);
    const initial = {
      ...initialProjection,
      turnItems: [historicalFailure.item],
      visibleTurnItems: [historicalFailure, row(200, 1, "inherited")],
    };
    const expanded = mergeOlderHistoryIntoProjection(
      initial,
      Array.from({ length: 20 }, (_, index) => row(index + 1, index)),
    );
    expect(
      expanded.visibleTurnItems.find(
        (entry) => entry.sourceItemId === historicalFailure.sourceItemId,
      )?.position,
    ).toBe(20);
    const freshFailure = row(101, 22);
    const live = {
      ...expanded,
      turnItems: [...expanded.turnItems, freshFailure.item],
      visibleTurnItems: [...expanded.visibleTurnItems, freshFailure],
    };
    const snapshot = (
      projection: {
        readonly visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
      },
      activityRunId: RunId | null = secondRun,
    ) => ({
      ...(activityRunId === null ? idle(null, null) : busy("working", activityRunId)),
      ...deliveryFailureSnapshot(
        projection.visibleTurnItems.map((projectedItem) => ({
          kind: "event" as const,
          id: projectedItem.item.id,
          createdAt: "2026-06-20T00:00:00.000Z",
          projectedItem,
        })),
        activityRunId,
      ),
    });
    expect(speak([snapshot(initial), snapshot(expanded), snapshot(expanded)])).toEqual([]);
    expect(speak([snapshot(initial), snapshot(expanded), snapshot(live), snapshot(live)])).toEqual([
      "Correction delivery not confirmed. Send it again if needed.",
    ]);
    const newerRunId = RunId.make("run-newer");
    expect(
      speak([
        snapshot(initial),
        snapshot(expanded, newerRunId),
        snapshot(live, newerRunId),
        snapshot(live, newerRunId),
      ]),
    ).toEqual(["Working", "Correction delivery not confirmed. Send it again if needed."]);
    expect(speak([snapshot(initial, null), snapshot(live, null), snapshot(live, null)])).toEqual([
      "Correction delivery not confirmed. Send it again if needed.",
    ]);
  });

  it("announces the end of a turn that was already running when the thread opened", () => {
    expect(speak([busy(), idle(secondRun, "failed")])).toEqual(["Failed"]);
  });

  it("says how the turn ended when a queued message was cancelled before it started", () => {
    const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
    const run = (id: RunId, ordinal: number, status: OrchestrationV2Run["status"]) =>
      ({
        id,
        threadId: ThreadId.make("thread-1"),
        ordinal,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        providerThreadId: null,
        userMessageId: MessageId.make(`message-${ordinal}`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: status === "cancelled" ? null : now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      }) satisfies OrchestrationV2Run;
    const cancelledRun = RunId.make("run-3");
    const ended = announcedRun({ runId: cancelledRun, status: "cancelled", startedAt: null }, [
      run(secondRun, 1, "completed"),
      run(cancelledRun, 2, "cancelled"),
    ]);
    expect(speak([busy(), idle(ended?.runId ?? null, ended?.status ?? null)])).toEqual(["Done"]);
  });

  it("waits for the run to settle before announcing how the turn ended", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "running"),
        idle(secondRun, "interrupted"),
      ]),
    ).toEqual(["Working", "Stopped"]);
  });

  it("does not report the previous turn's ending when work stops before a new run exists", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The previous run finished while this client looked idle.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "completed"),
        busy("working", secondRun, "completed"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working"]);
  });

  it("lets the next turn start after one is rolled back", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "rolled_back"),
        busy("working", RunId.make("run-3")),
      ]),
    ).toEqual(["Working", "Working"]);
  });

  it("announces each request once without repeating that work resumed", () => {
    expect(
      speak([
        busy(),
        busy("approval"),
        busy("approval"),
        busy(),
        busy("input"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Needs approval", "Needs your input", "Done"]);
  });

  it("announces a second request of the same kind once the first is answered", () => {
    expect(
      speak([
        busy(),
        busy("approval", secondRun, "running", "request-1"),
        busy("approval", secondRun, "running", "request-2"),
      ]),
    ).toEqual(["Needs approval", "Needs approval"]);
  });
});

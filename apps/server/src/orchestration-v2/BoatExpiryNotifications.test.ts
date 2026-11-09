import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BoatService from "../boat/BoatService.ts";
import * as BoatExpiryNotifications from "./BoatExpiryNotifications.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const now = Date.parse("2026-11-01T12:00:00.000Z");
const warning = (requestId: string): BoatService.BoatExpiryWarning => ({
  projectId: ProjectId.make("project-boat-expiry"),
  threadId: ThreadId.make(requestId),
  requestId,
  sandboxId: `sandbox-${requestId}`,
  expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 5 * 60_000)),
});

it.effect(
  "delivers once per deadline, retries failed delivery, and leaves stopped or waiting owners alone",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(now);
      const delivered = yield* Queue.unbounded<ThreadManagement.ThreadManagementSendInput>();
      const receipts = new Set<string>();
      let transientFailure = true;
      const first = warning("active");
      const renewed = {
        ...first,
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 65 * 60_000)),
      };
      const layer = BoatExpiryNotifications.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(BoatService.BoatService)({
              expiring: Stream.make(
                warning("stopped"),
                warning("waiting"),
                { ...warning("expired"), expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
                first,
                first,
                first,
                renewed,
              ),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              hasReceipt: (id) => Effect.succeed(receipts.has(id)),
              getProjectThreadRecords: (input) =>
                Effect.succeed({
                  thread: { archivedAt: null, deletedAt: null, settledOverride: null },
                  runs: input.threadId === "stopped" ? [{ ordinal: 1, status: "interrupted" }] : [],
                  runtimeRequests:
                    input.threadId === "waiting" ? [{ status: "pending", kind: "user_input" }] : [],
                } as never),
              sendToThread: (input) =>
                Effect.suspend(() => {
                  if (transientFailure) {
                    transientFailure = false;
                    return Effect.die("transient delivery failure");
                  }
                  receipts.add(input.commandId);
                  return Queue.offer(delivered, input).pipe(Effect.as({} as never));
                }),
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const beforeRenewal = yield* Queue.take(delivered);
        const afterRenewal = yield* Queue.take(delivered);
        assert.equal(beforeRenewal.threadId, first.threadId);
        assert.equal(beforeRenewal.mode, "auto");
        assert.include(beforeRenewal.text, first.expiresAt);
        assert.include(beforeRenewal.text, "retains its disk");
        assert.include(afterRenewal.text, renewed.expiresAt);
        assert.notEqual(beforeRenewal.commandId, afterRenewal.commandId);
        assert.equal(receipts.size, 2);
      }).pipe(Effect.provide(layer));
    }),
);

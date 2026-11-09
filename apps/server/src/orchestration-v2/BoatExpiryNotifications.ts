import { CommandId, MessageId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BoatService from "../boat/BoatService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const boats = yield* BoatService.BoatService;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const notify = Effect.fn("BoatExpiryNotifications.notify")(function* (
      warning: BoatService.BoatExpiryWarning,
    ) {
      if (Date.parse(warning.expiresAt) <= (yield* Clock.currentTimeMillis)) return;
      const identity = `boat-expiry:${warning.requestId}:${warning.expiresAt}`;
      const commandId = CommandId.make(identity);
      if (yield* threads.hasReceipt(commandId)) return;
      const projection = yield* threads.getProjectThreadRecords(warning, [
        "runs",
        "runtimeRequests",
      ]);
      const latest = projection.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.thread.settledOverride === "settled" ||
        (latest !== undefined &&
          ["cancelled", "interrupted", "failed", "rolled_back"].includes(latest.status)) ||
        projection.runtimeRequests.some(
          (request) => request.status === "pending" && request.kind !== "dynamic_tool_call",
        )
      )
        return;
      yield* threads.sendToThread({
        projectId: warning.projectId,
        threadId: warning.threadId,
        commandId,
        messageId: MessageId.make(identity),
        text: `Boat VM ${warning.sandboxId} (projectId: ${warning.projectId}, requestId: ${warning.requestId}) will stop at ${warning.expiresAt}. Decide now whether this VM is still needed. If work is continuing, use boat_environment renew with an explicit ttlMinutes. Otherwise preserve commits and required artifacts, then stop it. Do not renew merely because the user has not replied. At the deadline the VM stops independently of this thread and retains its disk for recovery; unrelated local work can continue.`,
        attachments: [],
        mode: "auto",
        createdBy: "system",
        creationSource: "server",
      });
    });
    yield* forkParked(
      Stream.runForEach(boats.expiring, (warning) =>
        notify(warning).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("boat.expiry-notification.failed", {
              requestId: warning.requestId,
              threadId: warning.threadId,
              cause,
            }),
          ),
        ),
      ),
    );
  }),
);

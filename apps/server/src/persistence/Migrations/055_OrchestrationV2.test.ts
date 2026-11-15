import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("055_OrchestrationV2", (it) => {
  it.effect("keeps released migrations contiguous", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(
        migrationManifest.map(([id]) => id),
        Array.from({ length: 103 }, (_, index) => index + 1),
      );
    }),
  );

  it.effect("upgrades released schema 53 through the latest migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });

      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, [
        [54, "ProjectionThreadsAutoSettleDisabledAt"],
        [55, "OrchestrationV2"],
        [56, "RemoveRedundantProjectionIndexes"],
        [57, "ScheduledTaskWebhooks"],
        [58, "WebhookRelayDeliveries"],
        [59, "McpAppModelContext"],
        [60, "ThreadSnapshotWindowIndexes"],
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
        [63, "CodexLiveVoice"],
        [64, "DropUnusedV1Projections"],
        [65, "CanonicalizeThreadPullRequestLinks"],
        [66, "CodexUsageNativeTurnIndex"],
        [67, "RepairClientSettlementTimestamps"],
        [68, "WebhookDedupe"],
        [69, "ApprovalReviewReadyIndex"],
        [70, "ApprovalReviewHostOrders"],
        [71, "ShellStopRequestIndex"],
        [72, "LiveVoiceHistoryEvents"],
        [73, "ThreadMessageSearch"],
        [74, "PeerLinks"],
        [75, "PeerLinkFence"],
        [76, "WaitingLinkRequestIndex"],
        [77, "ActiveTurnItemIndexes"],
        [78, "ExcludeAttachmentPlaceholdersFromSearch"],
        [79, "SubagentDeliveryState"],
        [80, "ProjectionProjectsPinArchive"],
        [81, "PrivilegedRecoveryIndexes"],
        [82, "ExecutionUsageIndexes"],
        [83, "RepairExecutionHistoryIndex"],
        [84, "ScheduledTaskDeliveryGeneration"],
        [85, "RepairBooleanSettledOverride"],
        [86, "DropOrchestrationEventCorrelationIndex"],
        [87, "DelegatedRecoveryIndexes"],
        [88, "ScheduledTaskThreadMode"],
        [89, "ProjectionMessageSearchText"],
        [90, "TurnItemConversationIndex"],
        [91, "CommandReadIndexes"],
        [92, "LastExecutedRunIndex"],
        [93, "TurnItemCounts"],
        [94, "QueuedTurnInputIndex"],
        [95, "ProjectionProjectsCustomTitle"],
        [96, "TurnItemTypeStatusIndex"],
        [97, "ShellThreadReadIndexes"],
        [98, "AuthConnectDevices"],
        [99, "AuthConnectDeniedRequests"],
        [100, "QueuedTurnInputIndexJsonValid"],
        [101, "ProviderTurnAttemptIndex"],
        [102, "TurnItemMessageOrdinalIndex"],
        [103, "TurnItemInlineWorkOutput"],
      ]);
      assert.deepStrictEqual(yield* runMigrations(), []);

      const migrations = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`
        SELECT migration_id, name
        FROM effect_sql_migrations
        WHERE migration_id >= 48
        ORDER BY migration_id
      `;
      assert.deepStrictEqual(migrations, [
        { migration_id: 48, name: "ProjectionThreadBranchPullRequest" },
        { migration_id: 49, name: "ProjectionThreadsActiveOrderKey" },
        { migration_id: 50, name: "ProjectionThreadPullRequests" },
        { migration_id: 51, name: "ProjectionThreadMessageContext" },
        { migration_id: 52, name: "ProjectionThreadTitleState" },
        { migration_id: 53, name: "PullRequestFilesViewed" },
        { migration_id: 54, name: "ProjectionThreadsAutoSettleDisabledAt" },
        { migration_id: 55, name: "OrchestrationV2" },
        { migration_id: 56, name: "RemoveRedundantProjectionIndexes" },
        { migration_id: 57, name: "ScheduledTaskWebhooks" },
        { migration_id: 58, name: "WebhookRelayDeliveries" },
        { migration_id: 59, name: "McpAppModelContext" },
        { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
        { migration_id: 61, name: "PullRequestReviewGuides" },
        { migration_id: 62, name: "ThreadFailureLookupIndex" },
        { migration_id: 63, name: "CodexLiveVoice" },
        { migration_id: 64, name: "DropUnusedV1Projections" },
        { migration_id: 65, name: "CanonicalizeThreadPullRequestLinks" },
        { migration_id: 66, name: "CodexUsageNativeTurnIndex" },
        { migration_id: 67, name: "RepairClientSettlementTimestamps" },
        { migration_id: 68, name: "WebhookDedupe" },
        { migration_id: 69, name: "ApprovalReviewReadyIndex" },
        { migration_id: 70, name: "ApprovalReviewHostOrders" },
        { migration_id: 71, name: "ShellStopRequestIndex" },
        { migration_id: 72, name: "LiveVoiceHistoryEvents" },
        { migration_id: 73, name: "ThreadMessageSearch" },
        { migration_id: 74, name: "PeerLinks" },
        { migration_id: 75, name: "PeerLinkFence" },
        { migration_id: 76, name: "WaitingLinkRequestIndex" },
        { migration_id: 77, name: "ActiveTurnItemIndexes" },
        { migration_id: 78, name: "ExcludeAttachmentPlaceholdersFromSearch" },
        { migration_id: 79, name: "SubagentDeliveryState" },
        { migration_id: 80, name: "ProjectionProjectsPinArchive" },
        { migration_id: 81, name: "PrivilegedRecoveryIndexes" },
        { migration_id: 82, name: "ExecutionUsageIndexes" },
        { migration_id: 83, name: "RepairExecutionHistoryIndex" },
        { migration_id: 84, name: "ScheduledTaskDeliveryGeneration" },
        { migration_id: 85, name: "RepairBooleanSettledOverride" },
        { migration_id: 86, name: "DropOrchestrationEventCorrelationIndex" },
        { migration_id: 87, name: "DelegatedRecoveryIndexes" },
        { migration_id: 88, name: "ScheduledTaskThreadMode" },
        { migration_id: 89, name: "ProjectionMessageSearchText" },
        { migration_id: 90, name: "TurnItemConversationIndex" },
        { migration_id: 91, name: "CommandReadIndexes" },
        { migration_id: 92, name: "LastExecutedRunIndex" },
        { migration_id: 93, name: "TurnItemCounts" },
        { migration_id: 94, name: "QueuedTurnInputIndex" },
        { migration_id: 95, name: "ProjectionProjectsCustomTitle" },
        { migration_id: 96, name: "TurnItemTypeStatusIndex" },
        { migration_id: 97, name: "ShellThreadReadIndexes" },
        { migration_id: 98, name: "AuthConnectDevices" },
        { migration_id: 99, name: "AuthConnectDeniedRequests" },
        { migration_id: 100, name: "QueuedTurnInputIndexJsonValid" },
        { migration_id: 101, name: "ProviderTurnAttemptIndex" },
        { migration_id: 102, name: "TurnItemMessageOrdinalIndex" },
        { migration_id: 103, name: "TurnItemInlineWorkOutput" },
      ]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'orchestration_v2_projection_threads',
            'orchestration_v2_projection_subagents',
            'orchestration_v2_effect_outbox',
            'orchestration_v2_turn_item_positions',
            'orchestration_v2_projection_metadata',
            'orchestration_v2_projection_provider_session_bindings',
            'orchestration_v2_thread_launch_workflows',
            'orchestration_v2_legacy_imports',
            'scheduled_tasks'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map(({ name }) => name),
        [
          "orchestration_v2_effect_outbox",
          "orchestration_v2_legacy_imports",
          "orchestration_v2_projection_metadata",
          "orchestration_v2_projection_provider_session_bindings",
          "orchestration_v2_projection_subagents",
          "orchestration_v2_projection_threads",
          "orchestration_v2_thread_launch_workflows",
          "orchestration_v2_turn_item_positions",
          "scheduled_tasks",
        ],
      );

      const eventColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_events)
      `;
      const receiptColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_command_receipts)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_threads)
      `;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(orchestration_v2_projection_subagents)
      `;
      assert.ok(eventColumns.some(({ name }) => name === "application_event_version"));
      assert.ok(receiptColumns.some(({ name }) => name === "command_type"));
      assert.ok(threadColumns.some(({ name }) => name === "provider_instance_id"));
      assert.ok(subagentColumns.some(({ name }) => name === "driver"));
      assert.ok(subagentColumns.some(({ name }) => name === "provider_instance_id"));

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'idx_orchestration_events_application_high_water',
            'orchestration_events_v2_created_threads_idx',
            'orchestration_v2_projection_turn_items_shell_pending_idx'
          )
        ORDER BY name
      `;
      assert.deepStrictEqual(
        indexes.map(({ name }) => name),
        [
          "idx_orchestration_events_application_high_water",
          "orchestration_events_v2_created_threads_idx",
          "orchestration_v2_projection_turn_items_shell_pending_idx",
        ],
      );
    }),
  );
});

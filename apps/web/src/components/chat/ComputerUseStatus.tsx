import { CircleAlertIcon, MonitorIcon } from "lucide-react";
import { tickTextContent } from "~/lib/tickTextContent";
import type { TimelineEntry } from "../../session-logic";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
import { useTurnItemDetail } from "../../state/queries";
import { turnItemDetailRevision } from "@t3tools/client-runtime/work-log/item-detail";
import { resolveComputerObservationItem } from "@t3tools/client-runtime/work-log/computer-observation-receipt";
import {
  computerInputState,
  isNativeInputTool,
} from "@t3tools/client-runtime/work-log/computer-input-receipt";
import {
  computerUseElapsed,
  deriveComputerUseStatus,
} from "@t3tools/client-runtime/work-log/computer-use-status";

export function ComputerUseStatus({
  entries,
  runId,
  isWorking,
  environmentId,
  confirmed,
}: {
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly runId: RunId | null;
  readonly isWorking: boolean;
  readonly environmentId: EnvironmentId;
  readonly confirmed: boolean;
}) {
  const connection = useEnvironment(environmentId)?.connection;
  const projection = entries.flatMap((entry) => {
    if (entry.attempt?.status === "superseded") return [];
    const projected =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : "projectedItem" in entry
          ? entry.projectedItem
          : undefined;
    return projected ? [projected] : [];
  });
  const projectionConfirmed = confirmed && connection?.phase === "connected";
  const state = deriveComputerUseStatus({
    items: projection.map((row) => row.item),
    runId,
    isWorking,
    confirmed: projectionConfirmed,
  });
  const wire = state?.inputItem;
  const row = projection.find((row) => row.item.id === wire?.id);
  const detail = useTurnItemDetail(
    projectionConfirmed &&
      wire &&
      row &&
      isNativeInputTool(wire.toolName) &&
      !["pending", "running", "waiting"].includes(wire.status) &&
      wire.outputOmitted
      ? {
          environmentId,
          threadId: row.sourceThreadId,
          itemId: row.sourceItemId,
          revision: turnItemDetailRevision(wire),
        }
      : null,
  );
  const resolved = wire
    ? resolveComputerObservationItem(wire, detail.data?.item, Boolean(detail.error))
    : null;
  const input =
    projectionConfirmed && resolved?.type === "dynamic_tool"
      ? computerInputState(resolved)
      : state?.input;
  if (!state || !input) return null;
  const Icon = state.failed ? CircleAlertIcon : MonitorIcon;
  return (
    <div className="chat-composer-lane shrink-0 border-b border-border bg-background py-2">
      <div className="chat-content-lane text-xs">
        <div
          role="status"
          aria-label="Computer Use activity"
          aria-live="polite"
          aria-atomic="true"
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{state.target ?? "Computer Use"}</span>
          <span className={state.failed ? "text-destructive" : "text-muted-foreground"}>
            {state.phase}
          </span>
          <span className="basis-full text-muted-foreground">
            {input.target && input.target !== state.target ? `${input.target} · ` : ""}
            {input.label}
          </span>
        </div>
        {state.action ? (
          <div className="mt-1 truncate text-muted-foreground">{state.action}</div>
        ) : null}
        <div className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground tabular-nums">
          {state.live && state.startedAt !== null ? (
            <span>
              Phase{" "}
              <span
                ref={tickTextContent((now) => computerUseElapsed(state.startedAt!, now), true)}
              />
            </span>
          ) : null}
          <span>
            Last event{" "}
            <span
              ref={tickTextContent(
                (now) => `${computerUseElapsed(state.lastEventAt, now)} ago`,
                true,
              )}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

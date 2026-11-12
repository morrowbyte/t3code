import { CircleAlertIcon, MonitorIcon } from "lucide-react";
import { tickTextContent } from "~/lib/tickTextContent";
import type { TimelineEntry } from "../../session-logic";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import { useEnvironment } from "../../state/environments";
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
  const items = entries.flatMap((entry) => {
    if (entry.attempt?.status === "superseded") return [];
    const projected =
      entry.kind === "work"
        ? entry.entry.projectedItem
        : "projectedItem" in entry
          ? entry.projectedItem
          : undefined;
    return projected ? [projected.item] : [];
  });
  const state = deriveComputerUseStatus({
    items,
    runId,
    isWorking,
    confirmed: confirmed && connection?.phase === "connected",
  });
  if (!state) return null;
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

import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { BoatState, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { boatEnvironment } from "../../state/boat";
import { useEnvironment } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { BOAT_SIZE_LABELS } from "./threadDetailsBoat";

const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
const hours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function ThreadDetailsBoat({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const allowed = useAtomValue(boatEnvironment.read.permissionAtom(environmentId));
  const connection = usePreparedConnection(environmentId);
  const connectionState = useEnvironment(environmentId)?.connection;
  const connected = connectionState?.phase === "connected";
  const read = useAtomCommand(boatEnvironment.read, { reportFailure: false });
  const refresh = useEffectEvent((targetEnvironment: EnvironmentId, targetProject: ProjectId) =>
    read({
      environmentId: targetEnvironment,
      input: { projectId: targetProject, analytics: { range: "month", threadId } },
    }),
  );
  const [revision, setRevision] = useState(0);
  const queryKey = JSON.stringify([environmentId, projectId, threadId]);
  const [result, setResult] = useState<{
    queryKey: string;
    connection: typeof connection;
    connectionState: typeof connectionState;
    revision: number;
    state: BoatState | null;
    failed: boolean;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read external Boat state on mount, explicit refresh and reconnection; discard replies from old connections.
  useEffect(() => {
    if (!allowed || !connected) return;
    let active = true;
    void refresh(environmentId, projectId).then(
      (response) => {
        if (active)
          setResult((previous) => ({
            queryKey,
            connection,
            connectionState,
            revision,
            state:
              response._tag === "Success"
                ? response.value
                : previous?.queryKey === queryKey
                  ? previous.state
                  : null,
            failed: response._tag !== "Success",
          }));
      },
      () => {
        if (active)
          setResult((previous) => ({
            queryKey,
            connection,
            connectionState,
            revision,
            state: previous?.queryKey === queryKey ? previous.state : null,
            failed: true,
          }));
      },
    );
    return () => {
      active = false;
    };
  }, [
    allowed,
    connected,
    connection,
    connectionState,
    environmentId,
    projectId,
    queryKey,
    revision,
  ]);

  const current =
    result?.queryKey === queryKey &&
    result.connection === connection &&
    result.connectionState === connectionState &&
    result.revision === revision
      ? result
      : null;
  const state = (allowed || !connected) && result?.queryKey === queryKey ? result.state : null;
  const loading = allowed && connected && current === null;
  const analytics = state?.analytics;
  const points = analytics?.instances.flatMap((instance) => instance.threadPoints) ?? [];
  const costs = points.flatMap((point) => (point.dollars === null ? [] : [point.dollars]));
  const seconds = points.flatMap((point) => (point.seconds === null ? [] : [point.seconds]));
  const empty = analytics?.instances.length === 0 && analytics.omittedInstances === 0;
  const cost = costs.length
    ? dollars.format(costs.reduce((sum, value) => sum + value, 0))
    : empty
      ? dollars.format(0)
      : "Unknown";
  const billableHours = seconds.length
    ? hours.format(seconds.reduce((sum, value) => sum + value, 0) / 3600)
    : empty
      ? "0"
      : "Unknown";
  const incomplete =
    (analytics?.omittedInstances ?? 0) > 0 ||
    points.some(
      (point) =>
        point.attribution === "unknown" ||
        point.status === "unavailable" ||
        point.dollars === null ||
        point.seconds === null,
    );
  const stale = points.some((point) => point.status === "stale");
  const starts = analytics?.instances.reduce((sum, instance) => sum + instance.starts, 0) ?? 0;
  const stops = analytics?.instances.reduce((sum, instance) => sum + instance.stops, 0) ?? 0;
  const status = !connected
    ? "Boat offline"
    : !allowed
      ? "Boat unavailable"
      : loading
        ? "Loading Boat…"
        : current?.failed || !state
          ? state
            ? "Could not refresh Boat · saved values"
            : "Could not refresh Boat"
          : !state.configured
            ? "Boat not connected"
            : !analytics
              ? "Boat analytics unavailable on this server"
              : null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-boat-heading"
      title="Boat"
      actions={
        <ThreadDetailsControl
          part="icon"
          aria-label="Refresh Boat"
          disabled={!allowed || !connected || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCwIcon aria-hidden />
        </ThreadDetailsControl>
      }
    >
      <div className="flex flex-col gap-1 px-2 text-xs">
        {status ? <p role="status">{status}</p> : null}
        {analytics ? (
          <>
            <dl
              className="grid min-w-0 grid-cols-2 gap-2"
              aria-label="Estimated thread usage this month"
            >
              <div className="min-w-0">
                <dt className="text-muted-foreground">Estimated thread share</dt>
                <dd className="break-all font-medium tabular-nums">{cost}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-muted-foreground">Estimated billable hours</dt>
                <dd className="break-all font-medium tabular-nums">{billableHours}</dd>
              </div>
            </dl>
            <p className="text-muted-foreground">
              This month · UTC{incomplete ? " · Incomplete history" : ""}
              {stale ? " · Saved measurements" : ""}
            </p>
            <p className="text-muted-foreground tabular-nums">
              Recorded VM activity · {starts} starts · {stops} stops
            </p>
            <details className="mt-1 text-muted-foreground">
              <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                VMs and account
              </summary>
              <dl className="mt-2 grid grid-cols-4 gap-1" aria-label="Active Boat instances">
                {Object.entries(BOAT_SIZE_LABELS).map(([size, label]) => (
                  <div key={size}>
                    <dt>{label}</dt>
                    <dd className="font-medium tabular-nums">
                      {analytics.activeInstances[size as keyof typeof BOAT_SIZE_LABELS]}
                    </dd>
                  </div>
                ))}
              </dl>
              {state?.account ? (
                <p className="mt-2 tabular-nums">
                  Account left · {hours.format(state.account.remainingHours)} default VM-h
                </p>
              ) : null}
            </details>
          </>
        ) : null}
        <ThreadDetailsControl
          render={
            <Link
              to="/boat"
              search={{
                machine: environmentId,
                project: projectId,
                thread: threadId,
                range: "month",
              }}
            />
          }
        >
          View analytics
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}

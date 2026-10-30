import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import type { BoatState, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { boatEnvironment } from "../../state/boat";
import { useEnvironment } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { BOAT_SIZE_LABELS, summarizeProjectBoat } from "./threadDetailsBoat";

const dollars = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const hours = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

export function ThreadDetailsBoat({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const allowed = useAtomValue(boatEnvironment.read.permissionAtom(environmentId));
  const connection = usePreparedConnection(environmentId);
  const connectionState = useEnvironment(environmentId)?.connection;
  const connected = connectionState?.phase === "connected";
  const read = useAtomCommand(boatEnvironment.read, { reportFailure: false });
  const refresh = useEffectEvent((targetEnvironment: EnvironmentId, targetProject: ProjectId) =>
    read({ environmentId: targetEnvironment, input: { projectId: targetProject } }),
  );
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    connection: typeof connection;
    connectionState: typeof connectionState;
    revision: number;
    state: BoatState | null;
  } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read external Boat state on mount, explicit refresh and reconnection; discard replies from old connections.
  useEffect(() => {
    if (!allowed || !connected) return;
    let active = true;
    void refresh(environmentId, projectId).then(
      (response) => {
        if (active)
          setResult({
            connection,
            connectionState,
            revision,
            state: response._tag === "Success" ? response.value : null,
          });
      },
      () => {
        if (active) setResult({ connection, connectionState, revision, state: null });
      },
    );
    return () => {
      active = false;
    };
  }, [allowed, connected, connection, connectionState, environmentId, projectId, revision]);

  const current =
    result?.connection === connection &&
    result.connectionState === connectionState &&
    result.revision === revision
      ? result
      : null;
  const state = allowed && connected ? current?.state : null;
  const loading = allowed && connected && current === null;
  const summary = state ? summarizeProjectBoat(state.instances, projectId) : null;
  const status = !connected
    ? "Boat offline"
    : !allowed
      ? "Boat unavailable"
      : loading
        ? "Loading Boat…"
        : !state
          ? "Could not refresh Boat"
          : !state.configured
            ? "Boat not connected"
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
        {state?.configured && summary ? (
          <>
            <dl className="grid grid-cols-4 gap-1" aria-label="Active Boat instances">
              {Object.entries(BOAT_SIZE_LABELS).map(([size, label]) => (
                <div key={size}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums">
                    {summary.active[size as keyof typeof BOAT_SIZE_LABELS]}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="tabular-nums">Project · {dollars.format(summary.costUsd)} this month</p>
            {state.account ? (
              <p className="text-muted-foreground tabular-nums">
                Account left · {hours.format(state.account.remainingHours)} default VM-h
              </p>
            ) : null}
          </>
        ) : null}
        <ThreadDetailsControl
          render={
            <Link to="/settings/integrations" search={{ machine: environmentId }} hash="boat" />
          }
        >
          Manage Boat
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}

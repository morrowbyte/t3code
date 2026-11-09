import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Link } from "@tanstack/react-router";
import type { BoatAction, BoatState, EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ExternalLinkIcon, PlusIcon, RefreshCwIcon, ServerIcon, SquareIcon } from "lucide-react";
import { useEffect, useEffectEvent, useId, useState } from "react";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { useNowMinute } from "../../hooks/useNowMinute";
import { randomUUID } from "../../lib/utils";
import { boatEnvironment } from "../../state/boat";
import { useEnvironment } from "../../state/environments";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { BOAT_SIZE_LABELS, boatRuntimeLabel, selectThreadBoats } from "./threadDetailsBoat";

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
  const canOperate = useAtomValue(boatEnvironment.operate.permissionAtom(environmentId));
  const connection = usePreparedConnection(environmentId);
  const connectionState = useEnvironment(environmentId)?.connection;
  const connected = connectionState?.phase === "connected";
  const read = useAtomCommand(boatEnvironment.read, { reportFailure: false });
  const operate = useAtomCommand(boatEnvironment.operate, { reportFailure: false });
  const nowMinute = useNowMinute();
  const runtimeInputId = useId();
  const [runtimeMinutes, setRuntimeMinutes] = useState("60");
  const [pending, setPending] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const refresh = useEffectEvent((targetEnvironment: EnvironmentId, targetProject: ProjectId) =>
    read({ environmentId: targetEnvironment, input: { projectId: targetProject } }),
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

  useLiveRefresh(() => setRevision((value) => value + 1), {
    enabled: allowed && connected,
    key: `thread-boats:${queryKey}`,
    intervalMs: 60_000,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read external Boat state on mount, refresh and reconnection; discard replies from old connections.
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
  const instances = selectThreadBoats(state?.instances ?? [], projectId, threadId);
  const ttlMinutes = Number(runtimeMinutes);
  const validRuntime = Number.isInteger(ttlMinutes) && ttlMinutes >= 1 && ttlMinutes <= 1440;
  const available = connected && canOperate && state?.configured === true && pending === null;
  const status = !connected
    ? "Offline · showing saved Boats"
    : !allowed
      ? "Boat access unavailable"
      : loading && !state
        ? "Loading Boats…"
        : current?.failed || !state
          ? state
            ? "Could not refresh · showing saved Boats"
            : "Could not load Boats"
          : !state.configured
            ? "Connect Boat in settings to add a VM."
            : null;

  const runOperation = async (action: BoatAction) => {
    if (!available) return;
    setPending(action.requestId);
    setOperationError(null);
    await Promise.resolve()
      .then(() => operate({ environmentId, input: action }))
      .then((response) => {
        if (response._tag === "Failure") {
          const error = squashAtomCommandFailure(response);
          setOperationError(error instanceof Error ? error.message : "Could not update Boat.");
        }
      })
      .catch((error: unknown) => {
        setOperationError(error instanceof Error ? error.message : "Could not update Boat.");
      })
      .finally(() => {
        setPending(null);
        setRevision((value) => value + 1);
      });
  };

  const start = async () => {
    if (!available || !validRuntime) return;
    await runOperation({
      action: "start",
      projectId,
      threadId,
      requestId: `thread-vm-${randomUUID()}`,
      ttlMinutes,
    });
  };

  return (
    <ThreadDetailsSection
      headingId="thread-details-boat-heading"
      title={`Boats${state ? ` · ${instances.length}` : ""}`}
      actions={
        <ThreadDetailsControl
          part="icon"
          aria-label="Refresh Boats"
          disabled={!allowed || !connected || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCwIcon aria-hidden />
        </ThreadDetailsControl>
      }
    >
      <div className="flex flex-col gap-2 px-2 text-xs">
        {status ? (
          <p role="status" className="text-muted-foreground">
            {status}
          </p>
        ) : null}
        {operationError ? (
          <p role="alert" className="text-destructive">
            {operationError}
          </p>
        ) : null}
        {state && instances.length === 0 ? (
          <p className="text-muted-foreground">No Boats owned by this thread.</p>
        ) : null}
        <ul className="m-0 flex list-none flex-col divide-y divide-border/60 p-0">
          {instances.map((instance) => {
            const name = instance.sandboxId ?? instance.requestId;
            const runtime = boatRuntimeLabel(instance, Date.parse(`${nowMinute}:00Z`));
            const resumable = instance.state === "stopped" || instance.state === "archived";
            const renewable = ["idle", "ready", "running"].includes(instance.state);
            const stoppable =
              instance.sandboxId !== null &&
              !["stopped", "archived", "deleting"].includes(instance.state);
            const busy = pending === instance.requestId;
            return (
              <li key={instance.requestId} className="min-w-0 py-2 first:pt-0 last:pb-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  <ServerIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 flex-1 truncate font-medium" />}
                    >
                      {name}
                    </TooltipTrigger>
                    <TooltipPopup>{name}</TooltipPopup>
                  </Tooltip>
                  <span className="shrink-0 text-muted-foreground">{instance.state}</span>
                </div>
                <p className="mt-0.5 text-muted-foreground">
                  {BOAT_SIZE_LABELS[instance.size]}
                  {runtime ? (
                    <>
                      {" "}
                      ·{" "}
                      <Tooltip>
                        <TooltipTrigger render={<time dateTime={instance.expiresAt} />}>
                          {runtime}
                        </TooltipTrigger>
                        <TooltipPopup>{new Date(instance.expiresAt).toLocaleString()}</TooltipPopup>
                      </Tooltip>
                    </>
                  ) : null}
                  {busy ? " · Updating…" : null}
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {renewable || resumable ? (
                    <ThreadDetailsControl
                      part="meta"
                      disabled={!available || !validRuntime}
                      onClick={() =>
                        void runOperation({
                          action: resumable ? "resume" : "renew",
                          projectId,
                          threadId,
                          requestId: instance.requestId,
                          ttlMinutes,
                        })
                      }
                      aria-label={`${resumable ? "Resume" : "Renew"} ${name} for ${runtimeMinutes} minutes`}
                    >
                      {resumable ? "Resume" : "Renew"}
                      {validRuntime ? ` · ${ttlMinutes} min` : ""}
                    </ThreadDetailsControl>
                  ) : null}
                  {instance.previewUrl ? (
                    <ThreadDetailsControl
                      part="meta"
                      render={<a href={instance.previewUrl} target="_blank" rel="noreferrer" />}
                    >
                      <ExternalLinkIcon aria-hidden /> Open
                    </ThreadDetailsControl>
                  ) : null}
                  {stoppable ? (
                    <ThreadDetailsControl
                      part="meta"
                      disabled={!available}
                      onClick={() =>
                        void runOperation({
                          action: "stop",
                          projectId,
                          threadId,
                          requestId: instance.requestId,
                        })
                      }
                      aria-label={`Stop ${name}`}
                    >
                      <SquareIcon aria-hidden /> Stop
                    </ThreadDetailsControl>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        {state?.configured ? (
          <div className="flex items-center gap-2">
            <label htmlFor={runtimeInputId} className="shrink-0 text-muted-foreground">
              Runtime
            </label>
            <div className="w-16">
              <Input
                id={runtimeInputId}
                type="number"
                size="compact"
                min={1}
                max={1440}
                value={runtimeMinutes}
                aria-invalid={!validRuntime}
                onChange={(event) => setRuntimeMinutes(event.target.value)}
              />
            </div>
            <span className="text-muted-foreground">min</span>
            <ThreadDetailsControl
              part="meta"
              disabled={!available || !validRuntime}
              onClick={() => void start()}
            >
              <PlusIcon aria-hidden /> Start
            </ThreadDetailsControl>
          </div>
        ) : null}
        <ThreadDetailsControl
          part="meta"
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
          Usage and history
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}

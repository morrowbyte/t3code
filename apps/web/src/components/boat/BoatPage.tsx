import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BoatAnalytics,
  type BoatAnalyticsInput,
  type BoatState,
  type BoatUsagePoint,
} from "@t3tools/contracts";
import { RefreshCwIcon, SettingsIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { isElectron } from "../../env";
import { boatEnvironment } from "../../state/boat";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { BOAT_SIZE_LABELS } from "../chat/threadDetailsBoat";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export type BoatSearch = {
  machine?: string | undefined;
  project?: string | undefined;
  thread?: string | undefined;
  range: BoatAnalyticsInput["range"];
};
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});
const hours = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const time = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

function sumPoints(points: readonly BoatUsagePoint[]) {
  const dollarValues = points.flatMap((point) => (point.dollars === null ? [] : [point.dollars]));
  const secondValues = points.flatMap((point) => (point.seconds === null ? [] : [point.seconds]));
  return {
    dollars: dollarValues.length ? dollarValues.reduce((sum, value) => sum + value, 0) : null,
    seconds: secondValues.length ? secondValues.reduce((sum, value) => sum + value, 0) : null,
    unknown: points.some(
      (point) =>
        point.attribution === "unknown" ||
        point.status === "unavailable" ||
        point.dollars === null ||
        point.seconds === null,
    ),
    stale: points.some((point) => point.status === "stale"),
  };
}

function coverageLabel(usage: ReturnType<typeof sumPoints>, estimated: boolean) {
  const labels = [
    usage.dollars === null && usage.seconds === null
      ? "Unknown"
      : estimated
        ? "Estimated"
        : "Measured",
  ];
  if (usage.unknown) labels.push("Incomplete history");
  if (usage.stale) labels.push("Saved measurements");
  return labels.join(" · ");
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select
        value={value}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue>
            <span className="block truncate">
              {options.find((item) => item.value === value)?.label ?? value}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <span className="block break-words">{item.label}</span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

export function BoatPage({
  search,
  onSearch,
}: {
  search: BoatSearch;
  onSearch: (next: BoatSearch) => void;
}) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = search.machine ? EnvironmentId.make(search.machine) : primaryId;
  return (
    <SidebarInset className="h-dvh min-h-0 min-w-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="min-w-0 flex-1 truncate font-medium">Boat</h1>
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link
              to="/settings/integrations"
              search={{ machine: environmentId ?? undefined }}
              hash="boat"
            />
          }
        >
          <SettingsIcon aria-hidden /> Settings
        </Button>
      </WorkspacePageHeader>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          {environmentId ? (
            <BoatEnvironmentPage
              key={environmentId}
              environmentId={environmentId}
              search={search}
              onSearch={onSearch}
              environments={environments.map((environment) => ({
                value: environment.environmentId,
                label: environment.label,
              }))}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              Connect an environment to view Boat usage.
            </p>
          )}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}

function BoatEnvironmentPage({
  environmentId,
  search,
  onSearch,
  environments,
}: {
  environmentId: EnvironmentId;
  search: BoatSearch;
  onSearch: (next: BoatSearch) => void;
  environments: readonly { value: string; label: string }[];
}) {
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const allowed = useAtomValue(boatEnvironment.read.permissionAtom(environmentId));
  const connection = usePreparedConnection(environmentId);
  const connectionState = useEnvironment(environmentId)?.connection;
  const connected = connectionState?.phase === "connected";
  const read = useAtomCommand(boatEnvironment.read, { reportFailure: false });
  const refresh = useEffectEvent(() =>
    read({
      environmentId,
      input: {
        ...(search.project ? { projectId: ProjectId.make(search.project) } : {}),
        analytics: {
          range: search.range,
          ...(search.thread ? { threadId: ThreadId.make(search.thread) } : {}),
        },
      },
    }),
  );
  const queryKey = JSON.stringify([search.project, search.thread, search.range]);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<Record<string, BoatState>>({});
  const [request, setRequest] = useState<{
    key: string;
    revision: number;
    connection: typeof connection;
    connectionState: typeof connectionState;
    error: string | null;
  } | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Synchronizes the selected query with Boat and keeps earlier measurements on refresh or connection failure.
  useEffect(() => {
    if (!allowed || !connected) return;
    let active = true;
    void refresh().then(
      (response) => {
        if (!active) return;
        if (response._tag === "Success" && response.value.analytics) {
          setResults((previous) =>
            Object.fromEntries([
              ...Object.entries(previous)
                .filter(([key]) => key !== queryKey)
                .slice(-19),
              [queryKey, response.value],
            ]),
          );
          setRequest({ key: queryKey, revision, connection, connectionState, error: null });
        } else {
          setRequest({
            key: queryKey,
            revision,
            connection,
            connectionState,
            error:
              response._tag === "Success"
                ? "Boat analytics is unavailable on this server."
                : "Could not refresh Boat usage.",
          });
        }
      },
      () => {
        if (active)
          setRequest({
            key: queryKey,
            revision,
            connection,
            connectionState,
            error: "Could not refresh Boat usage.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [allowed, connected, connection, connectionState, queryKey, revision]);

  const state = allowed || !connected ? results[queryKey] : undefined;
  const analytics = state?.analytics;
  const current =
    request?.key === queryKey &&
    request.revision === revision &&
    request.connection === connection &&
    request.connectionState === connectionState
      ? request
      : null;
  const loading = allowed && connected && current === null;
  const error = !connected
    ? "Offline. Showing saved measurements when available."
    : !allowed
      ? "Boat usage is unavailable with your current permissions."
      : (current?.error ?? null);
  const projectOptions = new Map(projects.map((project) => [project.id as string, project.title]));
  for (const id of Object.keys(state?.projects ?? {})) {
    if (!projectOptions.has(id)) projectOptions.set(id, id);
  }
  if (search.project && !projectOptions.has(search.project)) {
    projectOptions.set(search.project, search.project);
  }
  const threadOptions = new Map(
    threads
      .filter((thread) => !search.project || thread.projectId === search.project)
      .map((thread) => [thread.id as string, thread.title]),
  );
  for (const instance of analytics?.instances ?? []) {
    for (const id of instance.threadIds) {
      if (!threadOptions.has(id)) threadOptions.set(id, id);
    }
  }
  if (search.thread && !threadOptions.has(search.thread)) {
    threadOptions.set(search.thread, search.thread);
  }
  return (
    <>
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Filter
          label="Environment"
          value={environmentId}
          options={environments}
          onChange={(machine) => onSearch({ machine, range: search.range })}
        />
        <Filter
          label="Project"
          value={search.project ?? ""}
          options={[
            { value: "", label: "All projects" },
            ...[...projectOptions].map(([value, label]) => ({ value, label })),
          ]}
          onChange={(project) =>
            onSearch({ ...search, project: project || undefined, thread: undefined })
          }
        />
        <Filter
          label="Thread"
          value={search.thread ?? ""}
          options={[
            { value: "", label: "All threads" },
            ...[...threadOptions].map(([value, label]) => ({ value, label })),
          ]}
          onChange={(thread) =>
            onSearch({
              ...search,
              thread: thread || undefined,
              project: thread
                ? (threads.find((item) => item.id === thread)?.projectId ?? search.project)
                : search.project,
            })
          }
        />
        <Filter
          label="Period · UTC"
          value={search.range}
          options={[
            { value: "day", label: "Today" },
            { value: "week", label: "Last 7 days" },
            { value: "month", label: "This month" },
          ]}
          onChange={(range) => onSearch({ ...search, range: range as BoatSearch["range"] })}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status" className="min-w-0 break-words">
          {error ??
            (loading
              ? "Refreshing…"
              : analytics
                ? `Updated ${new Date(analytics.generatedAt).toLocaleString("en-US")}`
                : "No measurements loaded.")}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!allowed || !connected || loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCwIcon aria-hidden /> Refresh
        </Button>
      </div>
      {state && !state.configured ? (
        <p role="status" className="text-sm text-muted-foreground">
          Connect Boat in Settings to refresh usage.
        </p>
      ) : null}
      {analytics ? (
        <BoatMeasurements
          analytics={analytics}
          threadSelected={Boolean(search.thread)}
          projectLabel={(id) => projectOptions.get(id) ?? id}
          threadLabel={(id) => threadOptions.get(id) ?? id}
        />
      ) : null}
    </>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="mt-2 break-all text-2xl font-semibold tabular-nums">{value}</dd>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

function BoatMeasurements({
  analytics,
  threadSelected,
  projectLabel,
  threadLabel,
}: {
  analytics: BoatAnalytics;
  threadSelected: boolean;
  projectLabel: (id: string) => string;
  threadLabel: (id: string) => string;
}) {
  const [metric, setMetric] = useState<"dollars" | "seconds">("dollars");
  const selectedPoints = (instance: BoatAnalytics["instances"][number]) =>
    threadSelected ? instance.threadPoints : instance.points;
  const total = sumPoints(analytics.instances.flatMap(selectedPoints));
  const incomplete = total.unknown || analytics.omittedInstances > 0;
  const starts = analytics.instances.reduce((sum, instance) => sum + instance.starts, 0);
  const stops = analytics.instances.reduce((sum, instance) => sum + instance.stops, 0);
  const active = Object.values(analytics.activeInstances).reduce((sum, count) => sum + count, 0);
  const firstInstance = analytics.instances[0];
  const columns = (firstInstance ? selectedPoints(firstInstance) : []).map((point, index) => ({
    since: point.since,
    until: point.until,
    ...sumPoints(
      analytics.instances.flatMap((instance) => {
        const item = selectedPoints(instance)[index];
        return item ? [item] : [];
      }),
    ),
  }));
  const knownValues = columns.flatMap((point) => (point[metric] === null ? [] : [point[metric]]));
  const highestValue = knownValues.length ? Math.max(...knownValues) : null;
  const maximum = Math.max(highestValue ?? 0, 0.000001);
  const formatValue = (value: number | null) =>
    value === null
      ? "Unknown"
      : metric === "dollars"
        ? dollars.format(value)
        : `${hours.format(value / 3600)} h`;
  const empty = analytics.instances.length === 0 && analytics.omittedInstances === 0;
  const detail = incomplete
    ? "Incomplete · known values only"
    : total.stale
      ? "Saved measurements"
      : threadSelected
        ? "Based on recorded thread leases"
        : "Before plan or credit coverage";
  const valueLabel = threadSelected ? "Estimated thread share" : "VM list value";
  const hoursLabel = threadSelected ? "Estimated billable hours" : "Billable VM hours";
  return (
    <>
      <dl className="grid min-w-0 grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label={valueLabel}
          value={
            empty
              ? dollars.format(0)
              : total.dollars === null
                ? "Unknown"
                : dollars.format(total.dollars)
          }
          detail={detail}
        />
        <Metric
          label={hoursLabel}
          value={
            empty ? "0" : total.seconds === null ? "Unknown" : hours.format(total.seconds / 3600)
          }
          detail={incomplete ? "Incomplete · known values only" : "Includes VM size multiplier"}
        />
        <Metric label="Active VMs" value={String(active)} detail="Last observed state" />
        <Metric
          label="Recorded starts / stops"
          value={`${starts} / ${stops}`}
          detail={
            analytics.omittedInstances > 0 ||
            analytics.instances.some((instance) => instance.historyKnownSince === null)
              ? "Incomplete history · selected period"
              : "Selected period"
          }
        />
      </dl>
      {threadSelected ? (
        <p className="text-xs text-muted-foreground">
          Estimated share of VM list value, before plan or credit coverage.
        </p>
      ) : null}
      {incomplete ? (
        <p role="status" className="text-xs text-muted-foreground">
          Incomplete {threadSelected ? "thread history" : "measurements"}. Unknown intervals are
          excluded from totals.
          {analytics.omittedInstances > 0
            ? ` ${analytics.omittedInstances} more VMs are outside this view; narrow the filters.`
            : ""}
        </p>
      ) : null}
      <section
        aria-labelledby="boat-history"
        className="min-w-0 rounded-xl border border-border bg-card p-4"
      >
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
          <h2 id="boat-history" className="font-medium">
            {threadSelected ? "Estimated thread usage" : "VM usage history"}
          </h2>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Chart metric">
            <Button
              size="sm"
              variant={metric === "dollars" ? "secondary" : "ghost"}
              aria-pressed={metric === "dollars"}
              onClick={() => setMetric("dollars")}
            >
              {threadSelected ? "Estimated value" : "List value"}
            </Button>
            <Button
              size="sm"
              variant={metric === "seconds" ? "secondary" : "ghost"}
              aria-pressed={metric === "seconds"}
              onClick={() => setMetric("seconds")}
            >
              {threadSelected ? "Estimated hours" : "VM hours"}
            </Button>
          </div>
        </div>
        {columns.length ? (
          <>
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>Peak {formatValue(highestValue)}</span>
              <span>UTC</span>
            </div>
            <div
              className="grid h-44 gap-px border-b border-border sm:gap-1"
              style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
              role="img"
              aria-label={`${metric === "dollars" ? valueLabel + " in USD" : hoursLabel} by time interval. Exact values and coverage are in Chart data below.`}
            >
              {columns.map((point) => {
                const value = point[metric];
                return (
                  <Tooltip key={point.since}>
                    <TooltipTrigger
                      render={<div className="flex h-full min-w-0 items-end justify-center" />}
                    >
                      {value !== null ? (
                        <div
                          className={
                            point.unknown || point.stale
                              ? "w-full max-w-16 rounded-t border border-dashed border-primary bg-primary/40"
                              : "w-full max-w-16 rounded-t bg-primary"
                          }
                          style={{
                            height: `${Math.max(value > 0 ? 2 : 0, (value / maximum) * 100)}%`,
                          }}
                        />
                      ) : (
                        <div className="h-2 w-full border-t border-dashed border-muted-foreground" />
                      )}
                    </TooltipTrigger>
                    <TooltipPopup>{`${point.since} – ${point.until}: ${formatValue(value)} · ${coverageLabel(point, threadSelected)}`}</TooltipPopup>
                  </Tooltip>
                );
              })}
            </div>
            <div
              className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground"
              aria-hidden="true"
            >
              {[0, Math.floor((columns.length - 1) / 2), columns.length - 1]
                .filter((index, position, indices) => indices.indexOf(index) === position)
                .map((index) => (
                  <span key={columns[index]!.since}>
                    {analytics.range === "day"
                      ? time.format(new Date(columns[index]!.since))
                      : date.format(new Date(columns[index]!.since))}
                  </span>
                ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Dashed bars: incomplete or saved measurements.
            </p>
            <details className="mt-4 text-xs">
              <summary className="cursor-pointer rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                Chart data · UTC
              </summary>
              <table className="mt-2 w-full table-fixed text-left tabular-nums">
                <caption className="sr-only">
                  {threadSelected ? "Estimated thread usage" : "VM usage"} and source coverage by
                  interval, in UTC
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-2/5 py-2 pr-2 font-medium">
                      Interval
                    </th>
                    <th scope="col" className="w-1/4 break-words py-2 pr-2 font-medium">
                      {metric === "dollars"
                        ? threadSelected
                          ? "Estimated value"
                          : "List value"
                        : hoursLabel}
                    </th>
                    <th scope="col" className="break-words py-2 font-medium">
                      Coverage
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {columns.map((point) => (
                    <tr key={point.since} className="border-t border-border">
                      <th scope="row" className="break-words py-2 pr-2 font-normal">
                        <time dateTime={point.since}>
                          {date.format(new Date(point.since))} {time.format(new Date(point.since))}
                        </time>
                        {" – "}
                        <time dateTime={point.until}>
                          {date.format(new Date(point.until))} {time.format(new Date(point.until))}
                        </time>
                      </th>
                      <td className="break-all py-2 pr-2">{formatValue(point[metric])}</td>
                      <td className="break-words py-2">{coverageLabel(point, threadSelected)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No recorded VMs for this selection.</p>
        )}
      </section>
      <section aria-labelledby="boat-machines" className="flex min-w-0 flex-col gap-3">
        <h2 id="boat-machines" className="font-medium">
          Virtual machines
        </h2>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {Object.entries(BOAT_SIZE_LABELS).map(([size, label]) => (
            <span key={size}>
              {label} · {analytics.activeInstances[size as keyof typeof BOAT_SIZE_LABELS]} active
            </span>
          ))}
        </div>
        {analytics.instances.map((instance) => {
          const usage = sumPoints(instance.points);
          return (
            <article
              key={instance.requestId}
              className="min-w-0 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="break-all text-sm font-medium">
                    {instance.sandboxId ?? "Pending VM"}
                  </h3>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {BOAT_SIZE_LABELS[instance.size]} · {instance.state} ·{" "}
                    {projectLabel(instance.projectId)}
                  </p>
                </div>
                <dl className="min-w-0 text-sm tabular-nums">
                  <dt className="text-xs text-muted-foreground">Full VM list value</dt>
                  <dd className="break-all">
                    {usage.dollars === null ? "Unknown" : dollars.format(usage.dollars)}
                  </dd>
                  <dt className="mt-1 text-xs text-muted-foreground">Full VM billable hours</dt>
                  <dd className="break-all">
                    {usage.seconds === null ? "Unknown" : hours.format(usage.seconds / 3600)}
                  </dd>
                </dl>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {instance.starts} starts · {instance.stops} stops · selected period
              </p>
              {usage.unknown || usage.stale ? (
                <p className="mt-1 text-xs text-muted-foreground">{coverageLabel(usage, false)}</p>
              ) : null}
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  {instance.threadIds.length > 1
                    ? `Shared · ${instance.threadIds.length} recorded threads`
                    : `${instance.threadIds.length} recorded threads`}
                </summary>
                {instance.threadIds.length ? (
                  <ul className="mt-2 space-y-1">
                    {instance.threadIds.map((id) => (
                      <li key={id} className="break-words">
                        {threadLabel(id)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2">No thread association recorded.</p>
                )}
                <p className="mt-2 break-words">
                  {instance.historyKnownSince
                    ? `Associations recorded since ${new Date(instance.historyKnownSince).toLocaleString("en-US")}. Earlier history is unknown.`
                    : "Earlier thread history is unknown."}
                </p>
              </details>
            </article>
          );
        })}
      </section>
    </>
  );
}

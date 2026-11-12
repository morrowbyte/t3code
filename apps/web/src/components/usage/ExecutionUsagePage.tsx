import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { EnvironmentId, ProjectId, ThreadId, type ExecutionUsageEntry } from "@t3tools/contracts";
import { executionConfiguration } from "@t3tools/client-runtime/answer-cost";
import { useEffect, useEffectEvent, useState } from "react";
import { useEnvironment, useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { Button } from "../ui/button";
import {
  executionCostLabel,
  executionDurationLabel,
  isExecutionEstimatePartial,
  peakExecutionCost,
  samePromptExecutions,
  summarizeExecutions,
} from "./executionUsage";

export type ExecutionUsageSearch = {
  view?: "providers" | undefined;
  machine?: string | undefined;
  project?: string | undefined;
  thread?: string | undefined;
};

export function ExecutionUsagePage({
  search,
  onSearch,
}: {
  search: ExecutionUsageSearch;
  onSearch: (search: ExecutionUsageSearch) => void;
}) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = search.machine ? EnvironmentId.make(search.machine) : primaryId;
  return (
    <AppRouteModal label="Usage">
      <header className="flex min-h-12 flex-wrap items-center gap-2 border-b px-4">
        <h1 className="mr-auto font-medium">Usage</h1>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/usage" search={{ view: "providers" }} />}
        >
          Provider usage
        </Button>
        <Button
          variant="ghost"
          size="sm"
          render={<Link to="/settings/providers" search={environmentId ? { environmentId } : {}} />}
        >
          Settings
        </Button>
        <AppRouteModalClose />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="wide">
          <Filter
            label="Environment"
            value={environmentId ?? ""}
            options={environments.map((environment) => [
              environment.environmentId,
              environment.label,
            ])}
            onChange={(machine) => onSearch({ machine })}
          />
          {environmentId ? (
            <ExecutionEnvironment
              key={JSON.stringify([environmentId, search.project, search.thread])}
              environmentId={environmentId}
              search={search}
              onSearch={onSearch}
            />
          ) : (
            <p role="status">Connect an environment to view executions.</p>
          )}
        </WorkspacePageContainer>
      </div>
    </AppRouteModal>
  );
}

function ExecutionEnvironment({
  environmentId,
  search,
  onSearch,
}: {
  environmentId: EnvironmentId;
  search: ExecutionUsageSearch;
  onSearch: (search: ExecutionUsageSearch) => void;
}) {
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const threads = useAtomValue(environmentThreadShells.environmentThreadsAtom(environmentId));
  const allowed = useAtomValue(serverEnvironment.executionUsage.permissionAtom(environmentId));
  const connected = useEnvironment(environmentId)?.connection?.phase === "connected";
  const connection = usePreparedConnection(environmentId);
  const read = useAtomCommand(serverEnvironment.executionUsage, { reportFailure: false });
  const [revision, setRevision] = useState(0);
  const [response, setResponse] = useState<{
    connection: typeof connection;
    revision: number;
    result: Awaited<ReturnType<typeof read>>;
  } | null>(null);
  const current =
    response?.connection === connection && response.revision === revision ? response.result : null;
  const data = current?._tag === "Success" ? current.value : null;
  const failed = current?._tag === "Failure";
  const refresh = useEffectEvent(() =>
    read({
      environmentId,
      input: {
        ...(search.project ? { projectId: ProjectId.make(search.project) } : {}),
        ...(search.thread ? { threadId: ThreadId.make(search.thread) } : {}),
      },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected remote context and discards results after filters or connection change
  useEffect(() => {
    let active = true;
    if (allowed && connected)
      void refresh().then((result) => {
        if (!active) return;
        setResponse({ connection, revision, result });
      });
    return () => {
      active = false;
    };
  }, [allowed, connected, connection, revision]);
  const [comparisonKey, setComparisonKey] = useState("");
  const entries = data?.entries ?? [];
  const summary = summarizeExecutions(entries, data?.truncated ?? false);
  const comparisons = samePromptExecutions(entries, comparisonKey);
  const projectOptions = new Map(projects.map((project) => [project.id as string, project.title]));
  if (search.project && !projectOptions.has(search.project))
    projectOptions.set(search.project, search.project);
  const threadOptions = new Map(
    threads
      .filter((thread) => !search.project || thread.projectId === search.project)
      .map((thread) => [thread.id as string, thread.title]),
  );
  for (const entry of entries) threadOptions.set(entry.threadId, entry.threadTitle);
  if (search.thread && !threadOptions.has(search.thread))
    threadOptions.set(search.thread, search.thread);
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <Filter
          label="Project"
          value={search.project ?? ""}
          options={[["", "All projects"], ...projectOptions]}
          onChange={(project) =>
            onSearch({ ...search, project: project || undefined, thread: undefined })
          }
        />
        <Filter
          label="Thread"
          value={search.thread ?? ""}
          options={[["", "All threads"], ...threadOptions]}
          onChange={(thread) => onSearch({ ...search, thread: thread || undefined })}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!allowed || !connected}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          render={
            <Link
              to="/boat"
              search={{
                machine: environmentId,
                project: search.project,
                thread: search.thread,
                range: "month",
              }}
            />
          }
        >
          Compute usage
        </Button>
      </div>
      {!connected ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reconnect this environment to view executions.
        </p>
      ) : !allowed ? (
        <p role="alert" className="text-sm text-error-foreground">
          Read access to this environment is required.
        </p>
      ) : failed ? (
        <p role="alert" className="text-sm text-error-foreground">
          Executions could not be loaded. Reconnect this environment and refresh.
        </p>
      ) : !data ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading executions…
        </p>
      ) : entries.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No saved executions in this selection.
        </p>
      ) : (
        <>
          <section
            aria-label="Execution totals"
            className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b pb-4"
          >
            <div>
              <div className="text-xs text-muted-foreground">Saved API estimate</div>
              <div className="text-2xl font-medium tabular-nums">
                {executionCostLabel(summary.estimatedCostUsd, summary.incomplete)}
              </div>
            </div>
            <span className="text-sm text-muted-foreground">
              {entries.length} executions
              {summary.unknown > 0 ? ` · ${summary.unknown} with unknown cost` : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              Credits: unknown · Context reported:{" "}
              {entries.filter((entry) => entry.contextUsedTokens !== null).length}/{entries.length}
            </span>
          </section>
          <ExecutionChart entries={entries} />
          {data.truncated ? (
            <p role="status" className="text-xs text-muted-foreground">
              Latest 100 executions. Narrow the project or thread to see more relevant history.
            </p>
          ) : null}
          {comparisons.length > 1 ? (
            <section aria-labelledby="execution-comparison">
              <div className="flex items-center justify-between gap-3">
                <h2 id="execution-comparison" className="font-medium">
                  Same prompt · {comparisons.length} executions
                </h2>
                <Button variant="ghost" size="sm" onClick={() => setComparisonKey("")}>
                  Close comparison
                </Button>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Review results and context in each thread. Matching prompts can have different
                workspace state.
              </p>
              <div className="mt-3 grid gap-4 md:grid-cols-2">
                {comparisons.map((entry) => (
                  <article key={entry.runId} className="min-w-0 border-l-2 pl-3">
                    <ExecutionLink entry={entry} environmentId={environmentId} />
                    <Configuration entry={entry} />
                    <div className="mt-2 text-sm tabular-nums">
                      Main run · {entry.status} · {executionDurationLabel(entry.durationMs)} ·{" "}
                      {executionCostLabel(
                        entry.estimatedCostUsd,
                        isExecutionEstimatePartial(entry),
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Input: {entry.inputTokens?.toLocaleString() ?? "unknown"} · Output:{" "}
                      {entry.outputTokens?.toLocaleString() ?? "unknown"} tokens
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Child effort excluded from these main-run values.
                      {entry.delegatedChildren > 0
                        ? ` ${entry.delegatedChildren} delegated children; see thread usage.`
                        : ""}
                      {entry.unmeasuredSubagents ? " Additional child effort is unknown." : ""}
                    </p>
                    <h3 className="mt-3 text-xs text-muted-foreground">Result excerpt</h3>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {entry.result || "No saved result."}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          <section aria-labelledby="execution-history">
            <h2 id="execution-history" className="mb-3 font-medium">
              Execution history
            </h2>
            <div className="divide-y">
              {entries.map((entry) => (
                <details key={entry.runId} className="py-3">
                  <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="inline-grid w-[calc(100%_-_1.5rem)] min-w-0 gap-1 align-top sm:grid-cols-[minmax(0,1fr)_auto]">
                      <span className="min-w-0 truncate text-sm font-medium">
                        {entry.prompt || entry.threadTitle}
                      </span>
                      <span className="text-sm tabular-nums">
                        {executionCostLabel(
                          entry.estimatedCostUsd,
                          isExecutionEstimatePartial(entry),
                        )}
                      </span>
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {entry.threadTitle} · {entry.modelSelection.model}
                        {entry.parentThreadId ? " · child" : ""} · {entry.origin}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        }).format(new Date(entry.requestedAt))}{" "}
                        · {executionDurationLabel(entry.durationMs)}
                      </span>
                    </span>
                  </summary>
                  <div className="mt-3 space-y-3 pl-4">
                    <Configuration entry={entry} />
                    <p className="text-xs text-muted-foreground">
                      Measured input: {entry.inputTokens?.toLocaleString() ?? "unknown"} · output:{" "}
                      {entry.outputTokens?.toLocaleString() ?? "unknown"} tokens · {entry.status}
                    </p>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>
                        Context: {entry.contextUsedTokens?.toLocaleString() ?? "unknown"} /{" "}
                        {entry.contextMaxTokens?.toLocaleString() ?? "unknown"} tokens
                      </span>
                      {entry.contextUsedTokens !== null &&
                      entry.contextMaxTokens !== null &&
                      entry.contextMaxTokens > 0 ? (
                        <progress
                          aria-label="Context window used"
                          className="h-1.5 w-28 accent-primary"
                          max={entry.contextMaxTokens}
                          value={Math.min(entry.contextUsedTokens, entry.contextMaxTokens)}
                        />
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Saved token-rate estimate, not an invoice charge.
                      {entry.missingCostTurns > 0
                        ? ` ${entry.missingCostTurns} provider turns without a price.`
                        : ""}
                      {entry.unmeasuredSubagents
                        ? " Native or remote child costs may be missing."
                        : ""}
                      {entry.delegatedChildren > 0
                        ? ` ${entry.delegatedChildren} delegated children; their costs are excluded from this main-run estimate.`
                        : ""}
                    </p>
                    {entry.pricing.map((pricing) => (
                      <p key={JSON.stringify(pricing)} className="text-xs text-muted-foreground">
                        {pricing.source === "custom"
                          ? "Custom"
                          : pricing.source === "litellm"
                            ? "Published"
                            : "Unknown source"}{" "}
                        rates · {pricing.model ?? "unknown model"} · {pricing.serviceTier} · saved{" "}
                        {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                          new Date(pricing.pricedAt),
                        )}
                      </p>
                    ))}
                    {entry.origin === "voice" ? (
                      <p className="text-xs text-muted-foreground">
                        Voice conversation model and audio cost: unknown. Work execution is shown
                        above.
                      </p>
                    ) : null}
                    {entry.nativeChildren.map((child) => (
                      <div key={child.id} className="border-l pl-3 text-xs">
                        <p>
                          {child.title} · {child.status} · Cost unknown
                        </p>
                        <p className="break-words text-muted-foreground">
                          Model: {child.modelSelection?.model ?? child.model ?? "unknown"}
                          {child.modelSelection?.options
                            ?.map(({ id, value }) => ` · ${id}=${value}`)
                            .join("")}
                        </p>
                      </div>
                    ))}
                    {entry.nativeChildrenOmitted > 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {entry.nativeChildrenOmitted} more native children. Open the thread for full
                        history.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <ExecutionLink entry={entry} environmentId={environmentId} />
                      {samePromptExecutions(entries, entry.taskKey).length > 1 ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setComparisonKey(entry.taskKey)}
                        >
                          Compare same prompt
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </details>
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function ExecutionLink({
  entry,
  environmentId,
}: {
  entry: ExecutionUsageEntry;
  environmentId: EnvironmentId;
}) {
  return (
    <Link
      className="text-sm text-primary underline underline-offset-4"
      to="/$environmentId/$threadId"
      params={{ environmentId, threadId: entry.threadId }}
    >
      {entry.threadTitle}
    </Link>
  );
}

function Configuration({ entry }: { entry: ExecutionUsageEntry }) {
  const selection = entry.modelSelection;
  const configuration = executionConfiguration(selection);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-muted-foreground">Provider</dt>
      <dd className="break-words">{selection.instanceId}</dd>
      <dt className="text-muted-foreground">Run model</dt>
      <dd className="break-words">{selection.model}</dd>
      <dt className="text-muted-foreground">Reasoning</dt>
      <dd>{configuration.reasoning}</dd>
      <dt className="text-muted-foreground">Service tier</dt>
      <dd>{configuration.serviceTier}</dd>
      {selection.options?.length ? (
        <>
          <dt className="text-muted-foreground">Run options</dt>
          <dd className="break-words">
            {selection.options.map(({ id, value }) => `${id}=${value}`).join(" · ")}
          </dd>
        </>
      ) : null}
    </dl>
  );
}

function Filter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <select
        className="h-8 max-w-64 rounded-md border border-border bg-background px-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([key, title]) => (
          <option key={key} value={key}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
}

function ExecutionChart({ entries }: { entries: readonly ExecutionUsageEntry[] }) {
  const points = entries.slice(0, 24).toReversed();
  const observedPeak = peakExecutionCost(points);
  const peak = Math.max(observedPeak ?? 0, 0.001);
  return (
    <section aria-labelledby="execution-chart">
      <div className="flex flex-wrap justify-between gap-2">
        <h2 id="execution-chart" className="text-sm font-medium">
          API estimate per execution · USD
        </h2>
        <span className="text-xs text-muted-foreground">
          Max {executionCostLabel(observedPeak)} · ? unknown
        </span>
      </div>
      <svg
        role="img"
        aria-label={`Saved API estimates for the latest ${points.length} executions. Maximum ${executionCostLabel(observedPeak)}.`}
        viewBox="0 0 600 116"
        className="mt-3 h-32 w-full text-primary"
        preserveAspectRatio="none"
      >
        {points.map((entry, index) => (
          <g key={entry.runId}>
            <title>{`${entry.requestedAt} · ${entry.threadTitle}: ${executionCostLabel(entry.estimatedCostUsd, isExecutionEstimatePartial(entry))}`}</title>
            {entry.estimatedCostUsd === null ? (
              <text
                x={((index + 0.5) * 600) / points.length}
                y={96}
                fill="currentColor"
                textAnchor="middle"
                fontSize={12}
              >
                ?
              </text>
            ) : (
              <rect
                x={((index + 0.5) * 600) / points.length - 9}
                y={100 - (entry.estimatedCostUsd / peak) * 90}
                width={18}
                height={Math.max(1, (entry.estimatedCostUsd / peak) * 90)}
                fill="currentColor"
                opacity={isExecutionEstimatePartial(entry) ? 0.45 : 0.8}
              />
            )}
          </g>
        ))}
        <line x1={0} y1={102} x2={600} y2={102} stroke="currentColor" opacity={0.2} />
      </svg>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Oldest</span>
        <span>Newest</span>
      </div>
    </section>
  );
}

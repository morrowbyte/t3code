import { lazy, Suspense, useId, useState, type KeyboardEvent } from "react";
import {
  type RichVisualComponent,
  type VisualChart,
  type VisualFact,
  type VisualReport,
  type VisualStatus,
} from "@t3tools/shared/streamableUi";
import { Button } from "../ui/button";
import type { EnvironmentId } from "@t3tools/contracts";

const Chart = lazy(() => import("./RichChart").then((module) => ({ default: module.RichChart })));
const Workflow = lazy(() =>
  import("./RichWorkflow").then((module) => ({ default: module.RichWorkflow })),
);
const Uml = lazy(() => import("./RichUml").then((module) => ({ default: module.RichUml })));
const statusLabels: Record<VisualStatus, string> = {
  pending: "Pending",
  active: "In progress",
  complete: "Complete",
  blocked: "Blocked",
};

function Status({ status }: { status: VisualStatus | undefined }) {
  if (!status) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={`size-2 shrink-0 rounded-full ${status === "complete" ? "bg-success" : status === "active" ? "bg-primary" : status === "blocked" ? "bg-destructive" : "bg-muted-foreground"}`}
      />
      {statusLabels[status]}
    </span>
  );
}

function Facts({ facts }: { facts: VisualFact[] }) {
  return (
    <dl className="grid content-start self-start gap-2 text-sm">
      {facts.map((fact) => (
        <div
          key={fact.key}
          data-iui-entry=""
          className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-t border-border/50 pt-2"
        >
          <dt className="min-w-0 max-w-full text-muted-foreground [overflow-wrap:anywhere]">
            {fact.label}
          </dt>
          <dd className="ml-auto min-w-0 max-w-full text-right tabular-nums [overflow-wrap:anywhere]">
            {fact.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Report({ report }: { report: VisualReport }) {
  const id = useId();
  const [selected, setSelected] = useState<string>();
  const active = selected ?? report.sections[0]?.key;
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const count = report.sections.length;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % count
        : event.key === "ArrowLeft"
          ? (index - 1 + count) % count
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? count - 1
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setSelected(report.sections[next]!.key);
    document.getElementById(`${id}-tab-${report.sections[next]!.key}`)?.focus();
  };
  if (report.layout === "details")
    return (
      <div className="divide-y divide-border">
        {report.sections.map((section) => (
          <details data-iui-entry="" key={section.key} className="py-3 first:pt-0 last:pb-0">
            <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
              {section.title}
            </summary>
            <div className="grid gap-3 pt-3">
              {section.text ? (
                <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">
                  {section.text}
                </p>
              ) : null}
              <Facts facts={section.facts} />
            </div>
          </details>
        ))}
      </div>
    );
  return (
    <div className="grid min-w-0 gap-4">
      <div role="tablist" aria-label={report.title} className="flex flex-wrap gap-1">
        {report.sections.map((section, index) => (
          <Button
            key={section.key}
            id={`${id}-tab-${section.key}`}
            role="tab"
            aria-selected={active === section.key}
            aria-controls={`${id}-panel-${section.key}`}
            tabIndex={active === section.key ? 0 : -1}
            variant={active === section.key ? "secondary" : "ghost"}
            size="sm-multiline"
            onClick={() => setSelected(section.key)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            {section.title}
          </Button>
        ))}
      </div>
      {report.sections.map((section) => (
        <div
          key={section.key}
          role="tabpanel"
          id={`${id}-panel-${section.key}`}
          aria-labelledby={`${id}-tab-${section.key}`}
          hidden={active !== section.key}
          tabIndex={0}
          className="grid min-w-0 gap-4 rounded-md bg-secondary/30 p-4 focus-visible:outline-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]"
        >
          {section.text ? (
            <p className="whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{section.text}</p>
          ) : null}
          <Facts facts={section.facts} />
        </div>
      ))}
    </div>
  );
}

export function RichVisualBody({
  component,
  environmentId = null,
}: {
  component: RichVisualComponent;
  environmentId?: EnvironmentId | null | undefined;
}) {
  switch (component.type) {
    case "uml":
      return (
        <Suspense fallback={<p className="text-xs text-muted-foreground">Loading diagram…</p>}>
          <Uml diagram={component} environmentId={environmentId} />
        </Suspense>
      );
    case "cards":
      return (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
          {component.items.map((card) => (
            <article
              data-iui-entry=""
              key={card.key}
              aria-label={card.title}
              className="grid content-start gap-3 rounded-md border border-border p-3"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <h4 className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                  {card.title}
                </h4>
                {card.badge ? (
                  <span className="max-w-full rounded-md bg-secondary px-2 py-1 text-xs text-secondary-foreground [overflow-wrap:anywhere]">
                    {card.badge}
                  </span>
                ) : null}
              </div>
              {card.value !== undefined ? (
                <p className="text-xl font-semibold tabular-nums [overflow-wrap:anywhere]">
                  {card.value}
                </p>
              ) : null}
              {card.detail ? (
                <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {card.detail}
                </p>
              ) : null}
              <Facts facts={card.facts} />
            </article>
          ))}
        </div>
      );
    case "timeline":
      return (
        <ol className="grid gap-0">
          {component.items.map((item, index) => (
            <li
              data-iui-entry=""
              key={item.key}
              className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0"
            >
              <div aria-hidden className="flex flex-col items-center">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-secondary text-xs tabular-nums">
                  {index + 1}
                </span>
                {index < component.items.length - 1 ? (
                  <span className="mt-2 w-px flex-1 bg-border" />
                ) : null}
              </div>
              <div className="grid min-w-0 content-start gap-1">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h4 className="text-sm font-medium [overflow-wrap:anywhere]">{item.title}</h4>
                  <Status status={item.status} />
                </div>
                {item.time ? <p className="text-xs text-muted-foreground">{item.time}</p> : null}
                {item.detail ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground [overflow-wrap:anywhere]">
                    {item.detail}
                  </p>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      );
    case "workflow":
      return (
        <Suspense
          fallback={
            <div className="h-80" role="status">
              Loading workflow…
            </div>
          }
        >
          <Workflow workflow={component} />
        </Suspense>
      );
    case "report":
      return <Report report={component} />;
  }
}

export function RichChart({ chart }: { chart: VisualChart }) {
  return (
    <Suspense
      fallback={
        <div className="h-64" role="status">
          Loading chart…
        </div>
      }
    >
      <Chart chart={chart} />
    </Suspense>
  );
}

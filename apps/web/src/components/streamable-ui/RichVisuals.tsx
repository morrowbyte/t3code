import { lazy, Suspense, useId, useState, type KeyboardEvent } from "react";
import {
  type RichVisualComponent,
  type VisualChart,
  type VisualFact,
  type VisualReport,
  type VisualStatus,
} from "@t3tools/shared/streamableUi";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { CheckIcon, CircleDotIcon, CircleIcon, BanIcon } from "lucide-react";
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
  const Icon =
    status === "complete"
      ? CheckIcon
      : status === "active"
        ? CircleDotIcon
        : status === "blocked"
          ? BanIcon
          : CircleIcon;
  return (
    <Badge
      variant={
        status === "complete"
          ? "success"
          : status === "active"
            ? "info"
            : status === "blocked"
              ? "error"
              : "secondary"
      }
    >
      <Icon aria-hidden />
      {statusLabels[status]}
    </Badge>
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
        <Suspense
          fallback={
            <div
              role="status"
              className="grid place-items-center text-xs text-muted-foreground"
              style={{
                height: `calc(${component.kind === "class" ? "min(24rem, 55dvh)" : "min(18rem, 45dvh)"} + 4rem)`,
              }}
            >
              Loading diagram…
            </div>
          }
        >
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
                  <span className="max-w-full rounded border border-border px-2 py-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
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
        <ol className="grid gap-0" data-iui-timeline="">
          {component.items.map((item, index) => (
            <li
              data-iui-entry=""
              key={item.key}
              className="relative grid grid-cols-[32px_minmax(0,1fr)] gap-3 pb-3 last:pb-0"
            >
              {index < component.items.length - 1 ? (
                <span
                  aria-hidden
                  className={`absolute -bottom-1.5 left-[16px] top-[calc(32px+0.5rem)] w-px ${item.status === "complete" ? "bg-success/30" : "bg-border"}`}
                />
              ) : null}
              <span
                aria-hidden
                className={`relative z-10 mt-1.5 flex size-[32px] items-center justify-center rounded-full border text-xs font-medium tabular-nums ${item.status === "active" ? "border-primary bg-primary text-primary-foreground ring-4 ring-primary/10" : item.status === "complete" ? "border-success/30 bg-card text-success-foreground" : item.status === "blocked" ? "border-destructive/30 bg-card text-destructive-foreground" : "border-border bg-card text-muted-foreground"}`}
              >
                {item.status === "complete" ? (
                  <CheckIcon className="size-4" />
                ) : item.status === "active" ? (
                  <CircleDotIcon className="size-4" />
                ) : item.status === "blocked" ? (
                  <BanIcon className="size-4" />
                ) : (
                  index + 1
                )}
              </span>
              <div
                data-iui-status={item.status ?? "pending"}
                className={`grid min-w-0 content-start gap-2 rounded-lg border px-3 py-3 sm:px-4 ${item.status === "active" ? "border-primary/30 bg-primary/4" : "border-border bg-secondary/10"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h4 className="min-w-0 flex-[1_1_12ch] text-sm font-medium [overflow-wrap:anywhere]">
                    <span className="sr-only">Step {index + 1}. </span>
                    {item.title}
                  </h4>
                  <div className="ml-auto shrink-0">
                    <Status status={item.status} />
                  </div>
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
            <div
              className="grid place-items-center text-xs text-muted-foreground"
              style={{ height: "calc(min(32.5rem, 70dvh) + 2rem)" }}
              role="status"
            >
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

export function RichChart({ chart, isStreaming }: { chart: VisualChart; isStreaming: boolean }) {
  return (
    <Suspense
      fallback={
        <div
          className="grid place-items-center text-xs text-muted-foreground"
          style={{
            height:
              (["pie", "donut", "radar", "radial"].includes(chart.kind) || chart.horizontal
                ? 320
                : 256) + 128,
          }}
          role="status"
        >
          Loading chart…
        </div>
      }
    >
      <Chart chart={chart} isStreaming={isStreaming} />
    </Suspense>
  );
}

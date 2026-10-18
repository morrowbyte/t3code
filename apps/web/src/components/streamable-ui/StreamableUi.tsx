/* oxlint-disable react/no-array-index-key -- Protocol lists only append; positional keys keep existing rows and points mounted, including duplicate values. */
import { memo } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import "./streamable-ui.css";

import { RichChart, RichVisualBody } from "./RichVisuals";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import {
  parseStreamableUi,
  STREAMABLE_UI_LIMITS,
  type VisualSource,
  type VisualTable,
} from "./protocol";

function Sources({ sources }: { sources: VisualSource[] }) {
  if (sources.length === 0) return null;
  return (
    <ul aria-label="Sources" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
      {sources.map((source, index) => (
        <li key={index}>
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="underline">
            {source.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function DataTable({ title, columns, rows }: Pick<VisualTable, "title" | "columns" | "rows">) {
  return (
    <div
      role="region"
      aria-label={title}
      tabIndex={0}
      className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
    >
      <table className="w-full text-left text-sm tabular-nums">
        <caption className="sr-only">{title}</caption>
        <thead>
          <tr>
            {columns.map((column, index) => (
              <th key={index} scope="col" className="border-b border-border px-3 py-2 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr data-iui-entry="" key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className="border-b border-border/50 px-3 py-2">
                  {cell === null ? "—" : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const StreamableUi = memo(function StreamableUi({
  code,
  isStreaming,
  environmentId = null,
}: {
  code: string;
  isStreaming: boolean;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const parsed = parseStreamableUi(code, isStreaming);
  return (
    <div
      className="my-3 grid min-w-0 gap-3"
      data-streamable-ui=""
      data-markdown-copy={`\`\`\`t3-ui\n${code}\n\`\`\``}
    >
      {parsed.components.map((component) => (
        <section
          data-iui-entry=""
          key={component.id}
          aria-label={component.type === "metric" ? component.label : component.title}
          className="grid min-w-0 gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground [overflow-wrap:anywhere]"
        >
          {component.type === "metric" ? (
            <dl>
              <dt className="text-xs text-muted-foreground">{component.label}</dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums">{component.value}</dd>
              {component.detail ? (
                <dd className="mt-1 text-xs text-muted-foreground">{component.detail}</dd>
              ) : null}
            </dl>
          ) : (
            <>
              <p className="text-sm font-medium">{component.title}</p>
              <RenderErrorBoundary
                resetKeys={[code, environmentId]}
                fallback={
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Visual unavailable. View source</summary>
                    <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                      {code.slice(0, STREAMABLE_UI_LIMITS.characters)}
                    </pre>
                  </details>
                }
              >
                {component.type === "table" ? (
                  <DataTable {...component} />
                ) : component.type === "chart" ? (
                  <RichChart chart={component} />
                ) : (
                  <RichVisualBody component={component} environmentId={environmentId} />
                )}
              </RenderErrorBoundary>
            </>
          )}
          <Sources sources={component.sources} />
        </section>
      ))}
      {parsed.pending ? (
        <p role="status" className="text-xs text-muted-foreground">
          Receiving visual data…
        </p>
      ) : null}
      {parsed.error ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{parsed.error} View source</summary>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
            {code.slice(0, STREAMABLE_UI_LIMITS.characters)}
          </pre>
        </details>
      ) : null}
    </div>
  );
});

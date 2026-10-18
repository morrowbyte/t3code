/* oxlint-disable react/no-array-index-key -- Legacy chart samples may repeat labels; append indices remain stable. */
import { memo, useState } from "react";
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Polygon,
  Dot,
  Text,
  type BaseTickContentProps,
  Radar,
  RadarChart,
  RadialBar,
  RadialBarChart,
  Scatter,
  ComposedChart,
  Line,
  Label,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartDataModel, formatChartTick } from "@t3tools/shared/streamableUiLayout";
import type { VisualChart } from "@t3tools/shared/streamableUi";
import { useVisualReducedMotion, useVisualTextScale } from "./useVisualMotion";
import { Button } from "../ui/button";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { chartCsv } from "@t3tools/shared/streamableUiLayout";

const colors = [
  "var(--primary)",
  "var(--success-foreground)",
  "var(--warning-foreground)",
  "var(--destructive-foreground)",
  "var(--foreground)",
];
type ChartModel = ReturnType<typeof chartDataModel>;
const emptyRadarPoints: ReadonlyArray<{ x: number; y: number; value: unknown }> = [];

function RadarSeriesShape({
  points = emptyRadarPoints,
  stroke = "currentColor",
  fill = "none",
}: {
  points?: ReadonlyArray<{ x: number; y: number; value: unknown }>;
  stroke?: string;
  fill?: string;
}) {
  // Recharts places missing radar samples at radius zero; gaps must stay unmeasured.
  return (
    <Polygon
      points={points.map((point) =>
        typeof point.value === "number" ? point : { x: Number.NaN, y: Number.NaN },
      )}
      stroke={stroke}
      fill={fill}
      fillOpacity={0.12}
      strokeWidth={2}
    />
  );
}

function RadarSample({
  cx,
  cy,
  value,
  stroke = "currentColor",
}: {
  cx?: number | undefined;
  cy?: number | undefined;
  value?: unknown;
  stroke?: string | undefined;
}) {
  return typeof value === "number" && cx !== undefined && cy !== undefined ? (
    <Dot cx={cx} cy={cy} r={3} stroke={stroke} fill="var(--card)" strokeWidth={2} />
  ) : (
    <g />
  );
}

function RadarCategoryTick({ x = 0, y = 0, textAnchor, payload }: BaseTickContentProps) {
  const label = String(payload?.value ?? "");
  return (
    <g>
      <title>{label}</title>
      <Text
        x={x}
        y={y}
        textAnchor={textAnchor ?? "middle"}
        verticalAnchor="middle"
        width={75}
        breakAll
        maxLines={2}
        fontSize="0.75rem"
        fill="var(--muted-foreground)"
      >
        {label}
      </Text>
    </g>
  );
}

function CategoryValues({
  chart,
  model,
  index,
}: {
  chart: VisualChart;
  model: ChartModel;
  index: number;
}) {
  return (
    <div
      className="grid min-w-0 gap-2 rounded-md border border-border bg-popover p-3 text-sm text-popover-foreground shadow-sm"
      data-chart-category={index}
    >
      <p className="font-medium [overflow-wrap:anywhere]">{model.categories[index]}</p>
      {chart.kind === "scatter" ? (
        <p className="text-xs text-muted-foreground">
          {chart.xLabel ?? "X"}: {model.xValues[index]}
        </p>
      ) : null}
      <dl className="grid gap-2">
        {model.series.map((series, seriesIndex) => (
          <div
            key={series.key}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
          >
            <dt className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-sm"
                style={{
                  backgroundColor:
                    colors[
                      (["pie", "donut", "radial"].includes(chart.kind) ? index : seriesIndex) %
                        colors.length
                    ],
                }}
              />
              <span className="[overflow-wrap:anywhere]">{series.label}</span>
            </dt>
            <dd className="ml-auto max-w-full tabular-nums [overflow-wrap:anywhere]">
              {model.values[index]?.[seriesIndex] ?? "—"}
              {model.values[index]?.[seriesIndex] !== null &&
              model.values[index]?.[seriesIndex] !== undefined &&
              chart.yLabel
                ? ` ${chart.yLabel}`
                : ""}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CategoryTooltip({
  chart,
  model,
  active,
  label,
  payload,
}: {
  chart: VisualChart;
  model: ChartModel;
  active?: boolean | undefined;
  label?: unknown;
  payload?: ReadonlyArray<{ payload?: unknown }> | undefined;
}) {
  const item = payload?.[0]?.payload;
  const index =
    typeof item === "object" && item !== null && "_index" in item
      ? Number(item._index)
      : Number(label);
  if (!active || !Number.isInteger(index) || !model.categories[index]) return null;
  return <CategoryValues chart={chart} model={model} index={index} />;
}

export const RichChart = memo(
  function RichChart({ chart }: { chart: VisualChart }) {
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [touchTooltip, setTouchTooltip] = useState(false);
    const [copyError, setCopyError] = useState(false);
    const { copyToClipboard, isCopied } = useCopyToClipboard({
      target: "chart CSV",
      onCopy: () => setCopyError(false),
      onError: () => setCopyError(true),
    });
    const reduceMotion = useVisualReducedMotion();
    const textScale = useVisualTextScale();
    const [keyboardFocused, setKeyboardFocused] = useState(false);
    const [plotWidth, setPlotWidth] = useState(300);
    const model = chartDataModel(chart);
    const circular = ["pie", "donut", "radial"].includes(chart.kind);
    const legend = circular
      ? model.categories.map((label, index) => ({
          key: `c${index}`,
          label,
          value: model.values[index]?.[0] ?? 0,
        }))
      : chart.series.length > 0
        ? model.series
        : [];
    const tooltip = (
      <Tooltip
        shared
        includeHidden
        filterNull={false}
        trigger={touchTooltip ? "click" : "hover"}
        isAnimationActive={false}
        {...(keyboardFocused ? { defaultIndex: 0 } : {})}
        cursor={{ stroke: "var(--muted-foreground)", strokeDasharray: "3 3" }}
        content={<CategoryTooltip chart={chart} model={model} />}
        wrapperStyle={{ maxWidth: "min(20rem, 85vw)", outline: "none" }}
      />
    );
    const motion = {
      isAnimationActive: !reduceMotion,
      animationBegin: 0,
      animationDuration: 320,
      animationEasing: "ease-out" as const,
    };
    const polarRows = model.rows
      .map((row, index) => ({
        ...row,
        value: model.values[index]?.[0] ?? 0,
        fill: colors[index % colors.length]!,
      }))
      .filter((row) => !hidden.has(`c${row._index}`));
    const plot =
      chart.kind === "pie" || chart.kind === "donut" ? (
        <PieChart accessibilityLayer>
          {tooltip}
          <Pie
            data={polarRows}
            dataKey="value"
            nameKey="label"
            innerRadius={chart.kind === "donut" ? "52%" : 0}
            outerRadius="82%"
            paddingAngle={2}
            stroke="var(--card)"
            strokeWidth={3}
            {...motion}
          >
            {polarRows.map((row) => (
              <Cell key={row._index} fill={row.fill} />
            ))}
            {chart.kind === "donut" ? (
              <Label
                position="center"
                value={formatChartTick(polarRows.reduce((sum, row) => sum + row.value, 0))}
                fill="var(--foreground)"
                fontSize={26}
                fontWeight={600}
              />
            ) : null}
          </Pie>
        </PieChart>
      ) : chart.kind === "radar" ? (
        <RadarChart
          accessibilityLayer
          data={model.rows}
          outerRadius={Math.max(30, Math.min(110, (plotWidth - 180) / 2))}
        >
          <PolarGrid stroke="var(--border)" />
          <PolarAngleAxis dataKey="label" tick={RadarCategoryTick} />
          <PolarRadiusAxis
            angle={90}
            domain={[0, model.domain[1]]}
            ticks={model.ticks.filter((tick) => tick >= 0)}
            tickFormatter={formatChartTick}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
          />
          {tooltip}
          {model.series.map((series, index) => (
            <Radar
              key={series.key}
              name={series.label}
              dataKey={`s${index}`}
              stroke={colors[index % colors.length]}
              fill={colors[index % colors.length]}
              fillOpacity={0.12}
              strokeWidth={2}
              hide={hidden.has(series.key)}
              shape={RadarSeriesShape}
              dot={RadarSample}
              {...motion}
            />
          ))}
        </RadarChart>
      ) : chart.kind === "radial" ? (
        <RadialBarChart
          accessibilityLayer
          data={polarRows}
          innerRadius="25%"
          outerRadius="92%"
          startAngle={90}
          endAngle={-270}
        >
          <PolarAngleAxis
            type="number"
            domain={[0, chart.maximum ?? model.domain[1]]}
            tick={false}
          />
          {tooltip}
          <RadialBar
            dataKey="value"
            background={{ fill: "var(--secondary)" }}
            cornerRadius={5}
            {...motion}
          />
        </RadialBarChart>
      ) : (
        <ComposedChart
          accessibilityLayer
          data={model.rows}
          layout={chart.horizontal ? "vertical" : "horizontal"}
          margin={{ top: 8, right: 12, left: 0, bottom: 8 }}
          stackOffset="sign"
        >
          <CartesianGrid
            vertical={!!chart.horizontal}
            horizontal={!chart.horizontal}
            stroke="var(--border)"
            strokeDasharray="3 3"
          />
          {chart.horizontal ? (
            <>
              <XAxis
                key={`x-${textScale}`}
                type="number"
                domain={model.domain}
                ticks={model.ticks}
                tickFormatter={formatChartTick}
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                interval="preserveStartEnd"
                height="auto"
              />
              <YAxis
                key={`y-${textScale}`}
                dataKey="_index"
                type="category"
                tickFormatter={(index) => model.categories[Number(index)] ?? ""}
                width={100}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <ReferenceLine x={0} stroke="var(--border)" />
            </>
          ) : (
            <>
              <XAxis
                key={`x-${textScale}`}
                dataKey={chart.kind === "scatter" ? "x" : "_index"}
                type={chart.kind === "scatter" ? "number" : "category"}
                {...(chart.kind === "scatter"
                  ? { domain: ["auto", "auto"] }
                  : { tickFormatter: (index: number) => model.categories[Number(index)] ?? "" })}
                height="auto"
                tickLine={false}
                axisLine={false}
                tickMargin={10}
                minTickGap={24}
                interval="preserveStartEnd"
              />
              <YAxis
                key={`y-${textScale}`}
                type="number"
                domain={model.domain}
                ticks={model.ticks}
                tickFormatter={formatChartTick}
                tickLine={false}
                axisLine={false}
                width="auto"
                tickMargin={8}
              />
              <ReferenceLine y={0} stroke="var(--border)" />
            </>
          )}
          {tooltip}
          {model.series.map((series, index) => {
            const kind = chart.kind === "composed" ? (series.kind ?? "line") : chart.kind;
            const common = {
              dataKey: `s${index}`,
              name: series.label,
              stroke: colors[index % colors.length]!,
              fill: colors[index % colors.length]!,
              hide: hidden.has(series.key),
              ...motion,
            };
            if (kind === "scatter") return <Scatter key={series.key} {...common} />;
            if (kind === "bar")
              return (
                <Bar
                  key={series.key}
                  {...common}
                  {...(chart.stacked ? { stackId: "total" } : {})}
                  radius={3}
                  maxBarSize={48}
                />
              );
            if (kind === "area")
              return (
                <Area
                  key={series.key}
                  {...common}
                  {...(chart.stacked ? { stackId: "total" } : {})}
                  type="monotone"
                  fillOpacity={0.14}
                  strokeWidth={2}
                  connectNulls={false}
                  dot={model.categories.length <= 12}
                />
              );
            return (
              <Line
                key={series.key}
                {...common}
                type="monotone"
                strokeWidth={2}
                connectNulls={false}
                dot={model.categories.length <= 24}
                strokeDasharray={index >= 5 ? "6 4" : "none"}
              />
            );
          })}
        </ComposedChart>
      );
    return (
      <div className="grid min-w-0 gap-3" data-rich-chart="">
        <div className="flex min-h-8 flex-wrap gap-1">
          {legend.map((series, index) => (
            <Button
              key={series.key}
              size="sm-multiline"
              variant="ghost"
              aria-pressed={!hidden.has(series.key)}
              aria-label={`${series.label} series`}
              onClick={() =>
                setHidden((previous) => {
                  const next = new Set(previous);
                  if (next.has(series.key)) next.delete(series.key);
                  else next.add(series.key);
                  return next;
                })
              }
            >
              <span
                aria-hidden
                className="h-1 w-4 rounded"
                style={{
                  backgroundColor: colors[index % colors.length],
                  opacity: hidden.has(series.key) ? 0.25 : 1,
                }}
              />
              {series.label}
              {"value" in series ? (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatChartTick(Number(series.value))}
                </span>
              ) : null}
            </Button>
          ))}
        </div>
        {(chart.horizontal ? chart.xLabel : chart.yLabel) ? (
          <p className="text-xs text-muted-foreground">
            {chart.horizontal ? chart.xLabel : chart.yLabel}
            {chart.kind === "radial" ? ` · Target ${chart.maximum ?? model.domain[1]}` : ""}
          </p>
        ) : null}
        <div
          data-iui-chart=""
          onPointerDown={(event) => setTouchTooltip(event.pointerType === "touch")}
          onKeyDownCapture={() => setTouchTooltip(false)}
          className="min-w-0"
          style={{
            overflowY: chart.horizontal ? "auto" : undefined,
            height: chart.horizontal || circular || chart.kind === "radar" ? 320 : 256,
          }}
          onFocusCapture={() => setKeyboardFocused(true)}
          onBlurCapture={() => setKeyboardFocused(false)}
          role="group"
          tabIndex={chart.horizontal ? 0 : undefined}
          aria-label={`${chart.title}. ${chart.xLabel ?? "Category"} versus ${chart.yLabel ?? "Value"}`}
        >
          {chart.points.length === 0 ? (
            <p
              role="status"
              className="grid h-full place-items-center text-xs text-muted-foreground"
            >
              Waiting for data…
            </p>
          ) : (
            <div
              style={{
                height: chart.horizontal
                  ? Math.max(320, model.categories.length * 44 * textScale)
                  : "100%",
              }}
            >
              <ResponsiveContainer width="100%" height="100%" minWidth={0} onResize={setPlotWidth}>
                {plot}
              </ResponsiveContainer>
            </div>
          )}
        </div>
        {!circular && chart.kind !== "radar" && (chart.horizontal ? chart.yLabel : chart.xLabel) ? (
          <p className="text-center text-xs text-muted-foreground">
            {chart.horizontal ? chart.yLabel : chart.xLabel}
          </p>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs underline focus-visible:outline-2 focus-visible:outline-ring">
            View data ({chart.points.length} {chart.points.length === 1 ? "point" : "points"})
          </summary>
          <div className="flex items-center justify-end gap-2 py-2">
            <span aria-live="polite" className="text-xs text-muted-foreground">
              {isCopied ? "Copied" : copyError ? "Copy failed" : ""}
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label={`Copy ${chart.title} data as CSV`}
              onClick={() => copyToClipboard(chartCsv(chart), undefined)}
            >
              {isCopied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            </Button>
          </div>
          <div
            role="region"
            aria-label={`${chart.title} data`}
            tabIndex={0}
            className="max-w-full overflow-x-auto focus-visible:outline-2 focus-visible:outline-ring"
          >
            <table className="w-full text-left text-sm tabular-nums">
              <caption className="sr-only">{chart.title} data</caption>
              <thead>
                <tr>
                  <th scope="col" className="p-2">
                    {chart.kind === "scatter" ? "Sample" : (chart.xLabel ?? "Category")}
                  </th>
                  {chart.kind === "scatter" ? (
                    <th scope="col" className="p-2">
                      {chart.xLabel ?? "X"}
                    </th>
                  ) : null}
                  {chart.series.length > 0 ? (
                    <th scope="col" className="p-2">
                      Series
                    </th>
                  ) : null}
                  <th scope="col" className="p-2">
                    {chart.yLabel ?? "Value"}
                  </th>
                </tr>
              </thead>
              <tbody>
                {chart.points.map((point, index) => (
                  <tr key={index}>
                    <td className="border-t border-border p-2">{point.label}</td>
                    {chart.kind === "scatter" ? (
                      <td className="border-t border-border p-2">{point.x}</td>
                    ) : null}
                    {chart.series.length > 0 ? (
                      <td className="border-t border-border p-2">
                        {chart.series.find((series) => series.key === point.series)?.label ??
                          chart.yLabel ??
                          "Value"}
                      </td>
                    ) : null}
                    <td className="border-t border-border p-2">{point.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    );
  },
  (previous, next) => JSON.stringify(previous.chart) === JSON.stringify(next.chart),
);

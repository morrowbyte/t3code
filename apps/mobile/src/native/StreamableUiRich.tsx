import type { PreparedConnection } from "@t3tools/client-runtime/connection";
/* oxlint-disable react/no-array-index-key -- Point records append; indices preserve duplicate labels and existing native elements. */
import { memo, useEffect, useId, useMemo, useRef, useState, type ComponentRef } from "react";
import {
  Pressable,
  ScrollView,
  View,
  processColor,
  useWindowDimensions,
  type ColorValue,
} from "react-native";
import type { EnvironmentId, UmlRenderRequest, UmlRenderResult } from "@t3tools/contracts";
import {
  createUmlSnapshotQueue,
  renderEnvironmentUml,
} from "@t3tools/client-runtime/state/streamable-uml";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { AtomRegistry } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../state/atom-registry";
import { usePreparedConnection } from "../state/session";
import * as Clipboard from "expo-clipboard";
import {
  arc,
  area,
  curveLinear,
  curveLinearClosed,
  line,
  lineRadial,
  pie,
  stack,
  stackOffsetDiverging,
} from "d3-shape";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedProps,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  chartDataModel,
  chartCsv,
  formatChartTick,
  routedEdgePath,
  workflowLayout,
} from "@t3tools/shared/streamableUiLayout";
import Svg, {
  Circle,
  ClipPath,
  Defs,
  G,
  Marker,
  Path,
  Rect,
  Text as SvgText,
  SvgXml,
} from "react-native-svg";
import { useResolveClassNames } from "uniwind";
import {
  type RichVisualComponent,
  type VisualChart,
  type VisualFact,
  type VisualReport,
  type VisualStatus,
  type VisualWorkflow,
  type VisualUml,
} from "@t3tools/shared/streamableUi";
import { AppText as Text } from "../components/ui/AppText";

const statusLabels: Record<VisualStatus, string> = {
  pending: "Pending",
  active: "In progress",
  complete: "Complete",
  blocked: "Blocked",
};

async function requestUmlSnapshot(
  connection: PreparedConnection,
  input: UmlRenderRequest,
  signal: AbortSignal,
) {
  const request = connectionAtomRuntime.fn<void>()(() =>
    Effect.gen(function* () {
      const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
      const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
      return yield* renderEnvironmentUml({
        prepared: connection,
        signer,
        remoteAuthorization,
        signal,
        diagram: input,
      });
    }),
  );
  appAtomRegistry.set(request, undefined);
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

function umlColor(
  value: ColorValue | undefined,
  fallback: string,
  background = "#000000",
  opacity = 1,
) {
  const color = processColor(value);
  if (typeof color !== "number") return fallback;
  const alpha = ((color >>> 24) / 255) * opacity;
  const base = Number.parseInt(background.slice(1), 16);
  return `#${[16, 8, 0]
    .map((shift) =>
      Math.round(((color >>> shift) & 255) * alpha + ((base >>> shift) & 255) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function NativeUml({
  diagram,
  environmentId,
}: {
  diagram: VisualUml;
  environmentId: EnvironmentId | null;
}) {
  const prepared = usePreparedConnection(environmentId);
  const { fontScale, height: screenHeight } = useWindowDimensions();
  const background = useResolveClassNames("bg-thread-canvas").backgroundColor;
  const surface = useResolveClassNames("bg-card").backgroundColor;
  const foreground = useResolveClassNames("text-foreground").color;
  const muted = useResolveClassNames("text-foreground-muted").color;
  const border = useResolveClassNames("border-border").borderColor;
  const primary = useResolveClassNames("text-primary").color;
  const palette = useMemo<UmlRenderRequest["palette"]>(() => {
    const canvas = umlColor(background, "#0f1724");
    return {
      background: canvas,
      surface: umlColor(surface, "#172033", canvas),
      foreground: umlColor(foreground, "#e5e7eb", canvas),
      muted: umlColor(muted, "#64748b", canvas),
      border: umlColor(muted, "#40506a", umlColor(border, "#40506a", canvas), 0.5),
      primary: umlColor(primary, "#60a5fa", canvas),
    };
  }, [background, surface, foreground, muted, border, primary]);
  const [frame, setFrame] = useState<Extract<UmlRenderResult, { status: "ready" }>>();
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(300);
  const queue = useRef<ReturnType<typeof createUmlSnapshotQueue> | null>(null);
  const snapshots = useRef(diagram.snapshots);
  useEffect(() => {
    snapshots.current = diagram.snapshots;
    queue.current?.update(diagram.snapshots);
  }, [diagram.snapshots]);
  useEffect(() => {
    if (prepared._tag === "None") return;
    const connection = prepared.value;
    let live = true;
    const next = createUmlSnapshotQueue({
      render: (source, signal) =>
        requestUmlSnapshot(connection, { kind: diagram.kind, source, palette }, signal),
      onResult: (result) => {
        if (!live) return;
        if (result.status === "ready") {
          setFrame(result);
          setError(false);
        } else setError(true);
      },
    });
    queue.current = next;
    next.update(snapshots.current);
    return () => {
      live = false;
      next.dispose();
      queue.current = null;
    };
  }, [prepared, diagram.kind, palette]);
  const button = (label: string, text: string, action: () => void) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={action}
      className="min-h-10 min-w-10 items-center justify-center rounded-md border border-border px-3"
    >
      <Text>{text}</Text>
    </Pressable>
  );
  const scale = zoom * Math.max(1, fontScale);
  const frameHeight = frame ? Math.min(480, screenHeight * 0.65, frame.height * scale) : 0;
  return (
    <View className="gap-2" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <View className="flex-row flex-wrap gap-2">
        {button("Zoom out diagram", "−", () => setZoom((v) => Math.max(0.25, v / 1.25)))}
        {button("Zoom in diagram", "+", () => setZoom((v) => Math.min(3, v * 1.25)))}
        {button(
          "Fit diagram",
          "Fit",
          () => frame && setZoom(Math.min(1, width / (frame.width * Math.max(1, fontScale)))),
        )}
        {error ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry diagram update"
            onPress={() => queue.current?.retry()}
            className="min-h-10 min-w-10 items-center justify-center rounded-md border border-border px-3"
          >
            <Text>Retry</Text>
          </Pressable>
        ) : null}
      </View>
      {frame ? (
        <ScrollView
          horizontal
          nestedScrollEnabled
          className="rounded-md border border-border"
          style={{ height: frameHeight }}
        >
          <ScrollView
            nestedScrollEnabled
            style={{ width: frame.width * scale, height: frameHeight }}
          >
            <SvgXml
              xml={frame.svg}
              width={frame.width * scale}
              height={frame.height * scale}
              accessibilityRole="image"
              accessibilityLabel={`${diagram.title}, ${diagram.kind} UML diagram`}
            />
          </ScrollView>
        </ScrollView>
      ) : (
        <Text className="text-xs text-foreground-muted">
          {diagram.snapshots.length === 0
            ? "Waiting for diagram data…"
            : error || prepared._tag === "None"
              ? "Diagram unavailable."
              : "Rendering diagram…"}
        </Text>
      )}
      {error && frame ? (
        <Text className="text-xs text-foreground-muted">Latest diagram update unavailable.</Text>
      ) : null}
      <Disclosure title="View notation">
        <Text selectable className="font-t3-mono text-xs">
          {diagram.snapshots.at(-1)?.source}
        </Text>
      </Disclosure>
    </View>
  );
}

function Facts({ facts }: { facts: VisualFact[] }) {
  return (
    <View className="gap-2">
      {facts.map((fact) => (
        <View
          key={fact.key}
          className="flex-row flex-wrap gap-x-3 gap-y-1 border-t border-border pt-2"
        >
          <Text className="min-w-0 max-w-full text-sm text-foreground-muted">{fact.label}</Text>
          <Text selectable className="ml-auto min-w-0 max-w-full text-right text-sm tabular-nums">
            {fact.value ?? "—"}
          </Text>
        </View>
      ))}
    </View>
  );
}

function Disclosure({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((previous) => !previous)}
        className="min-h-11 flex-row items-center gap-2 active:opacity-65"
      >
        <Text className="text-sm text-foreground-muted" accessibilityElementsHidden>
          {open ? "−" : "+"}
        </Text>
        <Text className="min-w-0 flex-1 font-t3-bold text-sm">{title}</Text>
      </Pressable>
      {open ? children : null}
    </View>
  );
}

function Report({ report }: { report: VisualReport }) {
  const [selected, setSelected] = useState<string>();
  const active = selected ?? report.sections[0]?.key;
  if (report.layout === "details")
    return (
      <View className="gap-3">
        {report.sections.map((section) => (
          <Disclosure key={section.key} title={section.title}>
            <View className="gap-3">
              {section.text ? (
                <Text selectable className="text-sm">
                  {section.text}
                </Text>
              ) : null}
              <Facts facts={section.facts} />
            </View>
          </Disclosure>
        ))}
      </View>
    );
  return (
    <View className="gap-3">
      <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
        {report.sections.map((section) => (
          <Pressable
            key={section.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: active === section.key }}
            className={`min-h-11 max-w-full justify-center rounded-md px-3 py-2 active:opacity-65 ${active === section.key ? "bg-subtle" : ""}`}
            onPress={() => setSelected(section.key)}
          >
            <Text className="font-t3-bold text-sm">{section.title}</Text>
          </Pressable>
        ))}
      </View>
      {report.sections.map((section) => (
        <View
          key={section.key}
          accessibilityLabel={section.title}
          style={{ display: active === section.key ? "flex" : "none" }}
          className="gap-3"
        >
          {section.text ? (
            <Text selectable className="text-sm">
              {section.text}
            </Text>
          ) : null}
          <Facts facts={section.facts} />
        </View>
      ))}
    </View>
  );
}

export function RichVisualBody({
  component,
  isStreaming = false,
  environmentId = null,
}: {
  component: RichVisualComponent;
  isStreaming?: boolean | undefined;
  environmentId?: EnvironmentId | null | undefined;
}) {
  const enter = useMemo(() => FadeIn.duration(180).reduceMotion(ReduceMotion.System), []);
  switch (component.type) {
    case "uml":
      return <NativeUml diagram={component} environmentId={environmentId} />;
    case "cards":
      return (
        <View className="gap-3">
          {component.items.map((item) => (
            <Animated.View
              key={item.key}
              entering={isStreaming ? enter : undefined}
              className="gap-3 rounded-md border border-border p-3"
            >
              <View className="flex-row flex-wrap items-start justify-between gap-2">
                <Text accessibilityRole="header" className="min-w-0 flex-1 font-t3-bold text-sm">
                  {item.title}
                </Text>
                {item.badge ? (
                  <Text className="max-w-full rounded-md bg-subtle px-2 py-1 text-xs">
                    {item.badge}
                  </Text>
                ) : null}
              </View>
              {item.value !== undefined ? (
                <Text selectable className="font-t3-bold text-xl tabular-nums">
                  {item.value}
                </Text>
              ) : null}
              {item.detail ? (
                <Text className="text-sm text-foreground-muted">{item.detail}</Text>
              ) : null}
              <Facts facts={item.facts} />
            </Animated.View>
          ))}
        </View>
      );
    case "timeline":
      return (
        <View className="gap-4">
          {component.items.map((item, index) => (
            <Animated.View
              key={item.key}
              entering={isStreaming ? enter : undefined}
              className="flex-row gap-3"
            >
              <View className="items-center gap-2">
                <View className="min-h-7 min-w-7 items-center justify-center rounded-full border border-border bg-subtle px-1">
                  <Text className="text-xs tabular-nums">{index + 1}</Text>
                </View>
                {index < component.items.length - 1 ? (
                  <View className="w-px flex-1 bg-border" />
                ) : null}
              </View>
              <View className="min-w-0 flex-1 gap-1">
                <Text accessibilityRole="header" className="font-t3-bold text-sm">
                  {item.title}
                </Text>
                {item.status ? (
                  <Text className="text-xs text-foreground-muted">{statusLabels[item.status]}</Text>
                ) : null}
                {item.time ? (
                  <Text className="text-xs text-foreground-muted">{item.time}</Text>
                ) : null}
                {item.detail ? (
                  <Text className="text-sm text-foreground-muted">{item.detail}</Text>
                ) : null}
              </View>
            </Animated.View>
          ))}
        </View>
      );
    case "workflow":
      return <NativeWorkflow workflow={component} />;
    case "report":
      return <Report report={component} />;
  }
}

const NativeWorkflow = memo(
  function NativeWorkflow({ workflow }: { workflow: VisualWorkflow }) {
    const { fontScale, height: screenHeight } = useWindowDimensions();
    const graph = useMemo(() => workflowLayout(workflow), [workflow]);
    const graphWidth = Math.max(300, graph.width);
    const graphHeight = Math.max(180, graph.height);
    const textScale = Math.max(1, fontScale);
    const maxFrameHeight = Math.max(120, Math.min(360, screenHeight * 0.65));
    const [viewportWidth, setViewportWidth] = useState(300);
    const [zoom, setZoom] = useState<number | "fit">(1);
    const fitZoom = Math.min(
      1,
      viewportWidth / (graphWidth * textScale),
      maxFrameHeight / (graphHeight * textScale),
    );
    const scale = (zoom === "fit" ? fitZoom : zoom) * textScale;
    const frameHeight = Math.min(maxFrameHeight, graphHeight * scale);
    const horizontalScroll = useRef<ComponentRef<typeof ScrollView>>(null);
    const verticalScroll = useRef<ComponentRef<typeof ScrollView>>(null);
    const [selected, setSelected] = useState<string>();
    const id = useId().replace(/:/g, "");
    const { color: primary } = useResolveClassNames("text-primary");
    const { color: foreground } = useResolveClassNames("text-foreground");
    const { color: card } = useResolveClassNames("text-card");
    const { color: muted } = useResolveClassNames("text-foreground-muted");
    const { color: border } = useResolveClassNames("text-border");
    const { color: warning } = useResolveClassNames("text-warning-foreground");
    const selectedNode = workflow.nodes.find((node) => node.key === selected);
    return (
      <View className="gap-3">
        <View className="flex-row flex-wrap gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom out workflow"
            onPress={() =>
              setZoom((current) =>
                Math.max(Math.min(0.25, fitZoom), (current === "fit" ? fitZoom : current) / 1.25),
              )
            }
            className="min-h-11 min-w-11 items-center justify-center rounded-md border border-border px-3"
          >
            <Text>−</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Zoom in workflow"
            onPress={() =>
              setZoom((current) => Math.min(3, (current === "fit" ? fitZoom : current) * 1.25))
            }
            className="min-h-11 min-w-11 items-center justify-center rounded-md border border-border px-3"
          >
            <Text>+</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fit workflow"
            onPress={() => {
              setZoom("fit");
              horizontalScroll.current?.scrollTo({ x: 0, animated: false });
              verticalScroll.current?.scrollTo({ y: 0, animated: false });
            }}
            className="min-h-11 min-w-11 items-center justify-center rounded-md border border-border px-3"
          >
            <Text>Fit</Text>
          </Pressable>
        </View>
        <ScrollView
          ref={horizontalScroll}
          horizontal
          nestedScrollEnabled
          accessibilityLabel={workflow.title}
          onLayout={(event) => setViewportWidth(Math.max(1, event.nativeEvent.layout.width))}
          style={{ height: frameHeight }}
        >
          <ScrollView
            ref={verticalScroll}
            nestedScrollEnabled
            style={{
              width: graphWidth * scale,
              height: frameHeight,
            }}
          >
            <Svg
              width={graphWidth * scale}
              height={graphHeight * scale}
              viewBox={`0 0 ${graphWidth} ${graphHeight}`}
            >
              <Defs>
                <Marker
                  id={`${id}-arrow`}
                  markerWidth={8}
                  markerHeight={8}
                  refX={8}
                  refY={4}
                  orient="auto"
                >
                  <Path d="M0 0 L8 4 L0 8 Z" fill={primary} />
                </Marker>
              </Defs>
              {graph.edges.map((edge) => (
                <G key={edge.key}>
                  <Path
                    key={edge.key}
                    d={routedEdgePath(edge.points)}
                    fill="none"
                    stroke={primary}
                    strokeWidth={1.5}
                    markerEnd={`url(#${id}-arrow)`}
                  />
                  {edge.label && edge.labelX !== undefined && edge.labelY !== undefined ? (
                    <SvgText
                      x={edge.labelX}
                      y={edge.labelY - 3}
                      fill={muted}
                      textAnchor="middle"
                      fontSize={11}
                    >
                      {edge.label.length > 24 ? `${edge.label.slice(0, 23)}…` : edge.label}
                    </SvgText>
                  ) : null}
                </G>
              ))}
              {graph.nodes.map((node) => (
                <G
                  key={node.key}
                  onPress={() => setSelected(node.key)}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={`${node.title}, ${node.kind ?? "step"}, ${statusLabels[node.status ?? "pending"]}`}
                >
                  <Rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={node.height}
                    rx={8}
                    stroke={
                      selected === node.key ? primary : node.kind === "decision" ? warning : border
                    }
                    strokeWidth={selected === node.key ? 2.5 : 1}
                    fill={card}
                  />
                  <SvgText x={node.x + 12} y={node.y + 19} fill={muted} fontSize={10}>
                    {node.kind ?? "Step"} · {statusLabels[node.status ?? "pending"]}
                  </SvgText>
                  <SvgText
                    x={node.x + 12}
                    y={node.y + 43}
                    fill={foreground}
                    textAnchor="start"
                    fontSize={14}
                  >
                    {node.title.length > 25 ? `${node.title.slice(0, 24)}…` : node.title}
                  </SvgText>
                  {node.detail ? (
                    <SvgText x={node.x + 12} y={node.y + 63} fill={muted} fontSize={10}>
                      {node.detail.length > 27 ? `${node.detail.slice(0, 26)}…` : node.detail}
                    </SvgText>
                  ) : null}
                </G>
              ))}
            </Svg>
          </ScrollView>
        </ScrollView>
        {selectedNode ? (
          <View className="gap-2 rounded-md border border-border p-3">
            <Text accessibilityRole="header" className="font-t3-bold text-sm">
              {selectedNode.title}
            </Text>
            {selectedNode.detail ? (
              <Text className="text-sm text-foreground-muted">{selectedNode.detail}</Text>
            ) : null}
            {workflow.edges
              .filter((edge) => edge.from === selectedNode.key)
              .map((edge) => (
                <Text key={edge.key} className="text-xs text-foreground-muted">
                  → {workflow.nodes.find((node) => node.key === edge.to)!.title}
                  {edge.label ? ` · ${edge.label}` : ""}
                </Text>
              ))}
          </View>
        ) : null}
        <Disclosure title={`View steps (${workflow.nodes.length})`}>
          <View className="gap-3">
            {workflow.nodes.map((node, index) => (
              <View key={node.key} className="gap-1">
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: selected === node.key }}
                  className="min-h-11 justify-center"
                  onPress={() => setSelected(node.key)}
                >
                  <Text className="font-t3-bold text-sm">
                    {index + 1}. {node.title}
                  </Text>
                </Pressable>
                {node.status ? (
                  <Text className="text-xs text-foreground-muted">{statusLabels[node.status]}</Text>
                ) : null}
                {node.detail ? (
                  <Text className="text-sm text-foreground-muted">{node.detail}</Text>
                ) : null}
                {workflow.edges
                  .filter((edge) => edge.from === node.key)
                  .map((edge) => (
                    <Text key={edge.key} className="text-xs text-foreground-muted">
                      → {workflow.nodes.find((target) => target.key === edge.to)!.title}
                      {edge.label ? ` · ${edge.label}` : ""}
                    </Text>
                  ))}
              </View>
            ))}
          </View>
        </Disclosure>
      </View>
    );
  },
  (previous, next) => JSON.stringify(previous.workflow) === JSON.stringify(next.workflow),
);

type ChartModel = ReturnType<typeof chartDataModel>;
type ChartSample = { index: number; value: number | null; start: number; end: number };
type ChartPlotProps = {
  chart: VisualChart;
  model: ChartModel;
  hidden: Set<string>;
  colors: Array<ColorValue | undefined>;
  border: ColorValue | undefined;
  width: number;
  fontScale: number;
  selected: number | null;
  onSelect: (index: number | null) => void;
};

const fullCircle = Math.PI * 2;
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

function ChartBar({
  x,
  y,
  width,
  height,
  fill,
  rx,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  fill: ColorValue | undefined;
  rx: number;
}) {
  const geometry = useSharedValue({ x, y, width, height });
  useEffect(() => {
    geometry.set(
      withTiming({ x, y, width, height }, { duration: 260, reduceMotion: ReduceMotion.System }),
    );
  }, [x, y, width, height, geometry]);
  const animatedProps = useAnimatedProps(() => geometry.get());
  return <AnimatedRect animatedProps={animatedProps} fill={fill} rx={rx} />;
}

function ChartDot({
  cx,
  cy,
  r,
  fill,
}: {
  cx: number;
  cy: number;
  r: number;
  fill: ColorValue | undefined;
}) {
  const geometry = useSharedValue({ cx, cy, r: 0 });
  useEffect(() => {
    geometry.set(withTiming({ cx, cy, r }, { duration: 260, reduceMotion: ReduceMotion.System }));
  }, [cx, cy, r, geometry]);
  const animatedProps = useAnimatedProps(() => geometry.get());
  return <AnimatedCircle animatedProps={animatedProps} fill={fill} />;
}

function categoryDescription(chart: VisualChart, model: ChartModel, index: number) {
  return [
    chart.kind === "scatter"
      ? `${model.categories[index]}. ${chart.xLabel ?? "X"}: ${model.xValues[index]}`
      : `${chart.xLabel ?? "Category"}: ${model.categories[index]}`,
    ...model.series.map((series, seriesIndex) => {
      const value = model.values[index]?.[seriesIndex];
      return `${series.label}: ${value ?? "No data"}${value !== null && value !== undefined && chart.yLabel ? ` ${chart.yLabel}` : ""}`;
    }),
  ].join(". ");
}

function chartLayers(chart: VisualChart, model: ChartModel, hidden: Set<string>) {
  const visible = model.series.flatMap((series, index) =>
    hidden.has(series.key) ? [] : [{ series, index }],
  );
  const stacked = chart.stacked
    ? stack<Array<number | null>, number>()
        .keys(visible.map(({ index }) => index))
        .value((row, index) => row[index] ?? 0)
        .offset(stackOffsetDiverging)(model.values)
    : undefined;
  return visible.map(({ series, index }, layerIndex) => ({
    index,
    kind: chart.kind === "composed" ? (series.kind ?? "line") : chart.kind,
    samples: model.values.map((row, category): ChartSample => {
      const value = row[index] ?? null;
      const bounds = stacked?.[layerIndex]?.[category];
      return {
        index: category,
        value,
        start: bounds ? bounds[value !== null && value < 0 ? 1 : 0] : 0,
        end: bounds ? bounds[value !== null && value < 0 ? 0 : 1] : (value ?? 0),
      };
    }),
  }));
}

function spacedIndices(length: number, maximum: number) {
  const count = Math.min(length, Math.max(2, maximum));
  return Array.from({ length: count }, (_, index) =>
    count === 1 ? 0 : Math.round((index * (length - 1)) / (count - 1)),
  );
}

function CartesianChart({
  chart,
  model,
  hidden,
  colors,
  border,
  width,
  fontScale,
  selected,
  onSelect,
}: ChartPlotProps) {
  const clipId = `chart${useId().replace(/:/g, "")}`;
  const horizontal = chart.kind === "bar" && chart.horizontal;
  const scatter = chart.kind === "scatter";
  const layers = useMemo(() => chartLayers(chart, model, hidden), [chart, model, hidden]);
  // Bars and filled areas need a visible zero even in a composed chart.
  const zeroBased =
    chart.kind === "area" ||
    chart.kind === "bar" ||
    (chart.kind === "composed" &&
      model.series.some((series) => series.kind === "bar" || series.kind === "area"));
  const domain = [
    zeroBased ? Math.min(0, model.domain[0]) : model.domain[0],
    zeroBased ? Math.max(0, model.domain[1]) : model.domain[1],
  ];
  const ticks = [...new Set([...model.ticks, ...(zeroBased ? [0] : [])])].sort((a, b) => a - b);
  const axisWidth = horizontal
    ? Math.min(width * 0.42, 128 * fontScale)
    : Math.min(
        width * 0.42,
        Math.max(
          52 * fontScale,
          ...ticks.map((tick) => formatChartTick(tick).length * 7 * fontScale + 12),
        ),
      );
  const plotWidth = Math.max(1, width - axisWidth);
  const categoryHeight = Math.max(
    48 * fontScale,
    ...model.categories.map(
      (label) =>
        Math.ceil((label.length * 7 * fontScale) / Math.max(1, axisWidth - 12)) * 17 * fontScale +
        12,
    ),
  );
  const height = horizontal
    ? Math.max(216, categoryHeight * model.categories.length)
    : Math.max(216, 144 * fontScale);
  const inset = 8;
  const numeric = (value: number) =>
    horizontal
      ? inset + ((value - domain[0]!) / (domain[1]! - domain[0]!)) * (plotWidth - inset * 2)
      : height - inset - ((value - domain[0]!) / (domain[1]! - domain[0]!)) * (height - inset * 2);
  const xMin = scatter ? Math.min(...model.xValues) : 0;
  const xMax = scatter ? Math.max(...model.xValues) : 0;
  const xPadding = xMin === xMax ? Math.max(Math.abs(xMin) * 0.05, 1) : (xMax - xMin) * 0.04;
  const xDomain = [xMin - xPadding, xMax + xPadding];
  const numericX = (value: number) =>
    inset + ((value - xDomain[0]!) / (xDomain[1]! - xDomain[0]!)) * (plotWidth - inset * 2);
  const categorical = (index: number) =>
    horizontal
      ? ((index + 0.5) * height) / model.categories.length
      : scatter
        ? numericX(model.xValues[index]!)
        : chart.kind === "bar" ||
            (chart.kind === "composed" && model.series.some((series) => series.kind === "bar"))
          ? ((index + 0.5) * plotWidth) / model.categories.length
          : model.categories.length === 1
            ? plotWidth / 2
            : inset + (index * (plotWidth - inset * 2)) / (model.categories.length - 1);
  const pointX = (sample: ChartSample) =>
    horizontal ? numeric(sample.end) : categorical(sample.index);
  const pointY = (sample: ChartSample) =>
    horizontal ? categorical(sample.index) : numeric(sample.end);
  const barLayers = layers.filter((layer) => layer.kind === "bar");
  const barSlot = Math.min(
    56,
    ((horizontal ? height : plotWidth) * 0.76) /
      model.categories.length /
      (chart.stacked ? 1 : Math.max(1, barLayers.length)),
  );
  const categoryTicks = spacedIndices(
    model.categories.length,
    Math.floor(plotWidth / (72 * fontScale)),
  );
  const labelWidth = Math.min(112 * fontScale, plotWidth / Math.max(1, categoryTicks.length));
  const labelHeight = Math.max(
    44,
    ...categoryTicks.map(
      (index) =>
        Math.ceil((model.categories[index]!.length * 7 * fontScale) / Math.max(1, labelWidth - 4)) *
          17 *
          fontScale +
        8,
    ),
  );
  const xTicks = [xMin, ...(xMin === xMax ? [] : [(xMin + xMax) / 2, xMax])];
  const numericTicks = horizontal ? ticks : xTicks;
  const numericTickIndices = spacedIndices(
    numericTicks.length,
    Math.floor(plotWidth / (72 * fontScale)),
  );
  const numericLabelWidth = plotWidth / Math.max(1, numericTickIndices.length);
  const hitOrder = model.categories
    .map((_, index) => index)
    .sort((a, b) => categorical(a) - categorical(b));
  return (
    <View>
      <View style={{ height, marginLeft: axisWidth }}>
        <Svg width={plotWidth} height={height}>
          <Defs>
            <ClipPath id={clipId}>
              <Rect width={plotWidth} height={height} />
            </ClipPath>
          </Defs>
          <Rect
            width={plotWidth}
            height={height}
            fill="transparent"
            onPress={() => onSelect(null)}
          />
          {ticks.map((tick) => (
            <Path
              key={tick}
              d={
                horizontal ? `M${numeric(tick)} 0 V${height}` : `M0 ${numeric(tick)} H${plotWidth}`
              }
              stroke={border}
              strokeDasharray={tick === 0 ? undefined : "3 3"}
            />
          ))}
          <G clipPath={`url(#${clipId})`}>
            {layers.map((layer) => {
              const color = colors[layer.index % colors.length];
              if (layer.kind === "bar")
                return (
                  <G key={layer.index}>
                    {layer.samples.map((sample) => {
                      if (sample.value === null) return null;
                      const band =
                        categorical(sample.index) +
                        (chart.stacked
                          ? 0
                          : (barLayers.indexOf(layer) - (barLayers.length - 1) / 2) * barSlot) -
                        barSlot * 0.42;
                      const start = numeric(sample.start);
                      const end = numeric(sample.end);
                      return (
                        <ChartBar
                          key={sample.index}
                          x={horizontal ? Math.min(start, end) : band}
                          y={horizontal ? band : Math.min(start, end)}
                          width={horizontal ? Math.abs(start - end) : barSlot * 0.84}
                          height={horizontal ? barSlot * 0.84 : Math.abs(start - end)}
                          rx={chart.stacked ? 0 : 2}
                          fill={color}
                        />
                      );
                    })}
                  </G>
                );
              const stroke = line<ChartSample>()
                .defined((sample) => sample.value !== null)
                .x(pointX)
                .y(pointY)(layer.samples);
              const fill =
                layer.kind === "area"
                  ? area<ChartSample>()
                      .defined((sample) => sample.value !== null)
                      .x((sample) => categorical(sample.index))
                      .y0((sample) => numeric(sample.start))
                      .y1((sample) => numeric(sample.end))(layer.samples)
                  : null;
              return (
                <G key={layer.index}>
                  {fill ? (
                    <Path d={fill} fill={color} opacity={chart.stacked ? 0.32 : 0.14} />
                  ) : null}
                  {stroke && layer.kind !== "scatter" ? (
                    <Path
                      d={stroke}
                      fill="none"
                      stroke={color}
                      strokeWidth={2}
                      strokeDasharray={layer.index >= 5 ? "6 4" : undefined}
                    />
                  ) : null}
                  {scatter || model.categories.length <= 24
                    ? layer.samples.map((sample) =>
                        sample.value === null ? null : (
                          <ChartDot
                            key={sample.index}
                            cx={pointX(sample)}
                            cy={pointY(sample)}
                            r={scatter ? 4 : 3}
                            fill={color}
                          />
                        ),
                      )
                    : null}
                </G>
              );
            })}
            {selected !== null && model.categories[selected] !== undefined ? (
              <Path
                d={
                  horizontal
                    ? `M0 ${categorical(selected)} H${plotWidth}`
                    : `M${categorical(selected)} 0 V${height}`
                }
                stroke={border}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
            ) : null}
          </G>
          {hitOrder.map((index, position) => {
            const previous = hitOrder[position - 1];
            const next = hitOrder[position + 1];
            const start =
              previous === undefined ? 0 : (categorical(previous) + categorical(index)) / 2;
            const end =
              next === undefined
                ? horizontal
                  ? height
                  : plotWidth
                : (categorical(index) + categorical(next)) / 2;
            return (
              <Rect
                key={index}
                accessible
                accessibilityLabel={`${categoryDescription(chart, model, index)}. Show chart tooltip${selected === index ? ", selected" : ""}`}
                x={horizontal ? 0 : start}
                y={horizontal ? start : 0}
                width={horizontal ? plotWidth : end - start}
                height={horizontal ? end - start : height}
                fill="transparent"
                onPress={() => onSelect(selected === index ? null : index)}
              />
            );
          })}
        </Svg>
      </View>
      {horizontal
        ? model.categories.map((label, index) => (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={categoryDescription(chart, model, index)}
              onPress={() => onSelect(selected === index ? null : index)}
              style={{
                position: "absolute",
                left: 0,
                top: categorical(index) - categoryHeight / 2,
                width: axisWidth - 8,
                minHeight: categoryHeight,
                justifyContent: "center",
              }}
            >
              <Text className="text-right text-xs text-foreground-muted">{label}</Text>
            </Pressable>
          ))
        : ticks.map((tick) => (
            <Text
              key={tick}
              style={{
                position: "absolute",
                top: numeric(tick) - 8 * fontScale,
                width: axisWidth - 8,
              }}
              className="text-right text-xs text-foreground-muted tabular-nums"
            >
              {formatChartTick(tick)}
            </Text>
          ))}
      <View
        style={{
          marginLeft: axisWidth,
          height: horizontal || scatter ? Math.max(44, 24 * fontScale) : labelHeight,
        }}
      >
        {horizontal || scatter
          ? numericTickIndices.map((index) => {
              const tick = numericTicks[index]!;
              return (
                <Text
                  key={tick}
                  style={{
                    position: "absolute",
                    top: 8,
                    left: Math.max(
                      0,
                      Math.min(
                        plotWidth - numericLabelWidth,
                        (horizontal ? numeric(tick) : numericX(tick)) - numericLabelWidth / 2,
                      ),
                    ),
                    width: numericLabelWidth,
                  }}
                  className="text-center text-xs text-foreground-muted tabular-nums"
                >
                  {formatChartTick(tick)}
                </Text>
              );
            })
          : categoryTicks.map((index) => (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={categoryDescription(chart, model, index)}
                onPress={() => onSelect(selected === index ? null : index)}
                style={{
                  position: "absolute",
                  left: Math.max(
                    0,
                    Math.min(plotWidth - labelWidth, categorical(index) - labelWidth / 2),
                  ),
                  width: labelWidth,
                  minHeight: 44,
                  paddingTop: 8,
                }}
              >
                <Text className="text-center text-xs text-foreground-muted">
                  {model.categories[index]}
                </Text>
              </Pressable>
            ))}
      </View>
    </View>
  );
}

function PolarChart({
  chart,
  model,
  hidden,
  colors,
  border,
  width,
  fontScale,
  selected,
  onSelect,
}: ChartPlotProps) {
  const radar = chart.kind === "radar";
  const height = radar ? Math.max(288, 212 * fontScale) : Math.max(256, width * 0.85);
  const radius = Math.max(
    1,
    radar
      ? Math.min(width * 0.25, height / 2 - 52 * fontScale)
      : Math.min(width / 2 - 12, height / 2 - 12),
  );
  const centerX = width / 2;
  const centerY = height / 2;
  const maximum = chart.maximum ?? Math.max(1, model.domain[1]);
  const positive = (value: number | null | undefined) => Math.max(0, value ?? 0);
  const rows = model.categories.flatMap((label, index) =>
    hidden.has(`c${index}`) ? [] : [{ index, label, value: positive(model.values[index]?.[0]) }],
  );
  const wedges = pie<(typeof rows)[number]>()
    .sort(null)
    .value((row) => row.value)
    .padAngle(0.025)(rows);
  const shape = arc();
  const hasPositive = rows.some((row) => row.value > 0);
  const categoryTicks = spacedIndices(model.categories.length, 8);
  const angle = (index: number) => (index * fullCircle) / model.categories.length;
  const labelWidth = Math.min(112 * fontScale, width * 0.36);
  return (
    <View style={{ height }}>
      <Svg width={width} height={height}>
        <Rect width={width} height={height} fill="transparent" onPress={() => onSelect(null)} />
        <G transform={`translate(${centerX} ${centerY})`}>
          {radar ? (
            <>
              {[0.5, 1].map((fraction) => (
                <Path
                  key={fraction}
                  d={
                    lineRadial<number>()
                      .angle((index) => angle(index))
                      .radius(radius * fraction)
                      .curve(curveLinearClosed)(model.categories.map((_, index) => index)) ?? ""
                  }
                  fill="none"
                  stroke={border}
                />
              ))}
              {model.categories.map((_, index) => (
                <Path
                  key={index}
                  d={`M0 0 L${Math.sin(angle(index)) * radius} ${-Math.cos(angle(index)) * radius}`}
                  stroke={border}
                />
              ))}
              {model.series.map((series, seriesIndex) => {
                if (hidden.has(series.key)) return null;
                const values = model.values.map((row, index) => ({
                  index,
                  value: row[seriesIndex] ?? null,
                }));
                const complete = values.every((sample) => sample.value !== null);
                const path = lineRadial<(typeof values)[number]>()
                  .defined((sample) => sample.value !== null)
                  .angle((sample) => angle(sample.index))
                  .radius((sample) => Math.min(1, positive(sample.value) / maximum) * radius)
                  .curve(complete ? curveLinearClosed : curveLinear)(values);
                const color = colors[seriesIndex % colors.length];
                return (
                  <G key={series.key}>
                    {path ? (
                      <Path
                        d={path}
                        stroke={color}
                        strokeWidth={2}
                        strokeDasharray={seriesIndex >= 5 ? "6 4" : undefined}
                        fill={complete ? color : "none"}
                        fillOpacity={0.12}
                      />
                    ) : null}
                    {values.map((sample) =>
                      sample.value === null ? null : (
                        <Circle
                          key={sample.index}
                          cx={
                            Math.sin(angle(sample.index)) *
                            Math.min(1, positive(sample.value) / maximum) *
                            radius
                          }
                          cy={
                            -Math.cos(angle(sample.index)) *
                            Math.min(1, positive(sample.value) / maximum) *
                            radius
                          }
                          r={3}
                          fill={color}
                        />
                      ),
                    )}
                  </G>
                );
              })}
              {model.categories.map((_, index) => (
                <Path
                  key={index}
                  accessible
                  accessibilityLabel={`${categoryDescription(chart, model, index)}. Show chart tooltip${selected === index ? ", selected" : ""}`}
                  d={
                    shape({
                      innerRadius: 0,
                      outerRadius: radius + 12,
                      startAngle: angle(index) - Math.PI / model.categories.length,
                      endAngle: angle(index) + Math.PI / model.categories.length,
                    }) ?? ""
                  }
                  fill="transparent"
                  onPress={() => onSelect(selected === index ? null : index)}
                />
              ))}
            </>
          ) : chart.kind === "radial" ? (
            rows.map((row, ring) => {
              const band = (radius * 0.76) / Math.max(1, rows.length);
              const innerRadius = radius * 0.24 + ring * band;
              const outerRadius = innerRadius + band * 0.8;
              return (
                <G
                  key={row.index}
                  accessible
                  accessibilityLabel={`${categoryDescription(chart, model, row.index)}. Target ${maximum}${chart.yLabel ? ` ${chart.yLabel}` : ""}. Show chart tooltip${selected === row.index ? ", selected" : ""}`}
                  onPress={() => onSelect(selected === row.index ? null : row.index)}
                >
                  <Path
                    d={
                      shape({ innerRadius, outerRadius, startAngle: 0, endAngle: fullCircle }) ?? ""
                    }
                    fill={border}
                    opacity={0.45}
                  />
                  <Path
                    d={
                      shape({
                        innerRadius,
                        outerRadius,
                        startAngle: 0,
                        endAngle: Math.min(1, row.value / maximum) * fullCircle,
                      }) ?? ""
                    }
                    fill={colors[row.index % colors.length]}
                  />
                  <Path
                    d={
                      shape({
                        innerRadius: Math.max(0, innerRadius - band * 0.1),
                        outerRadius: outerRadius + band * 0.1,
                        startAngle: 0,
                        endAngle: fullCircle,
                      }) ?? ""
                    }
                    fill="transparent"
                  />
                </G>
              );
            })
          ) : hasPositive ? (
            wedges.map((wedge) => (
              <Path
                key={wedge.data.index}
                accessible
                accessibilityLabel={`${categoryDescription(chart, model, wedge.data.index)}. Show chart tooltip${selected === wedge.data.index ? ", selected" : ""}`}
                d={
                  shape({
                    innerRadius: chart.kind === "donut" ? radius * 0.52 : 0,
                    outerRadius: radius,
                    startAngle: wedge.startAngle,
                    endAngle: wedge.endAngle,
                    padAngle: wedge.padAngle,
                  }) ?? ""
                }
                fill={colors[wedge.data.index % colors.length]}
                stroke={border}
                strokeWidth={selected === wedge.data.index ? 3 : 1}
                onPress={() => onSelect(selected === wedge.data.index ? null : wedge.data.index)}
              />
            ))
          ) : (
            <Circle r={radius} stroke={border} fill="none" />
          )}
        </G>
      </Svg>
      {radar ? (
        <>
          {[0, maximum / 2, maximum].map((tick) => (
            <Text
              key={tick}
              style={{
                position: "absolute",
                left: centerX + 4,
                top: centerY - (tick / maximum) * radius - 7 * fontScale,
              }}
              pointerEvents="none"
              className="text-xs text-foreground-muted tabular-nums"
            >
              {formatChartTick(tick)}
            </Text>
          ))}
          {categoryTicks.map((index) => {
            const dx = Math.sin(angle(index));
            const dy = -Math.cos(angle(index));
            const labelHeight = Math.max(
              44,
              Math.ceil((model.categories[index]!.length * 7 * fontScale) / labelWidth) *
                17 *
                fontScale,
            );
            const x =
              centerX +
              dx * (radius + 12) -
              (dx > 0.25 ? 0 : dx < -0.25 ? labelWidth : labelWidth / 2);
            const y =
              centerY +
              dy * (radius + 12) -
              (dy < -0.25 ? labelHeight : dy > 0.25 ? 0 : labelHeight / 2);
            return (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={categoryDescription(chart, model, index)}
                onPress={() => onSelect(selected === index ? null : index)}
                style={{
                  position: "absolute",
                  left: Math.max(0, Math.min(width - labelWidth, x)),
                  top: Math.max(0, Math.min(height - labelHeight, y)),
                  width: labelWidth,
                  minHeight: 44,
                  justifyContent: "center",
                }}
              >
                <Text
                  className="text-xs text-foreground-muted"
                  style={{ textAlign: dx > 0.25 ? "left" : dx < -0.25 ? "right" : "center" }}
                >
                  {model.categories[index]}
                </Text>
              </Pressable>
            );
          })}
        </>
      ) : !hasPositive && chart.kind !== "radial" ? (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center px-6">
          <Text className="text-center text-sm text-foreground-muted">
            {rows.length ? "No positive values" : "All categories hidden"}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const RichChart = memo(
  function RichChart({ chart }: { chart: VisualChart }) {
    const model = useMemo(() => chartDataModel(chart), [chart]);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set());
    const [selected, setSelected] = useState<number | null>(null);
    const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
    const { fontScale } = useWindowDimensions();
    const [width, setWidth] = useState(300);
    const [frameHeight, setFrameHeight] = useState(260);
    const { color: primary } = useResolveClassNames("text-primary");
    const { color: secondary } = useResolveClassNames("text-foreground-secondary");
    const { color: warning } = useResolveClassNames("text-warning-foreground");
    const { color: danger } = useResolveClassNames("text-danger-foreground");
    const { color: foreground } = useResolveClassNames("text-foreground");
    const { color: border } = useResolveClassNames("text-border");
    const colors = [primary, secondary, warning, danger, foreground];
    useEffect(() => {
      if (copyState === "idle") return;
      const timer = setTimeout(() => setCopyState("idle"), 2200);
      return () => clearTimeout(timer);
    }, [copyState]);
    if (chart.points.length === 0)
      return <Text className="text-xs text-foreground-muted">No data points yet.</Text>;
    const circular = chart.kind === "pie" || chart.kind === "donut" || chart.kind === "radial";
    const polar = circular || chart.kind === "radar";
    const legend = circular
      ? model.categories.map((label, index) => ({ key: `c${index}`, label }))
      : chart.series.length > 0
        ? model.series
        : [];
    const active = selected !== null && model.categories[selected] !== undefined ? selected : null;
    const plotProps = {
      chart,
      model,
      hidden,
      colors,
      border,
      width,
      fontScale,
      selected: active,
      onSelect: setSelected,
    };
    return (
      <View className="gap-3">
        <View className="flex-row flex-wrap gap-2">
          {legend.map((series, seriesIndex) => (
            <Pressable
              key={series.key}
              accessibilityRole="button"
              accessibilityLabel={`${hidden.has(series.key) ? "Show" : "Hide"} ${series.label}${circular ? "" : " series"}`}
              accessibilityState={{ selected: !hidden.has(series.key) }}
              className="min-h-11 max-w-full flex-row items-center gap-2 rounded-md px-2 py-1 active:opacity-65"
              onPress={() => {
                setSelected(null);
                setHidden((previous) => {
                  const next = new Set(previous);
                  if (next.has(series.key)) next.delete(series.key);
                  else next.add(series.key);
                  return next;
                });
              }}
            >
              <View
                style={{
                  backgroundColor: colors[seriesIndex % colors.length],
                  opacity: hidden.has(series.key) ? 0.25 : 1,
                  width: 16,
                  height: 4,
                }}
              />
              <Text
                className={`min-w-0 shrink text-sm${hidden.has(series.key) ? " text-foreground-muted line-through" : ""}`}
              >
                {series.label}
              </Text>
            </Pressable>
          ))}
        </View>
        {(chart.horizontal ? chart.xLabel : !polar && chart.yLabel) || chart.kind === "radial" ? (
          <Text className="text-xs text-foreground-muted">
            {chart.kind === "radial"
              ? `Target ${chart.maximum ?? Math.max(1, model.domain[1])}${chart.yLabel ? ` ${chart.yLabel}` : ""}`
              : chart.horizontal
                ? chart.xLabel
                : chart.yLabel}
          </Text>
        ) : null}
        <View
          onLayout={(event) => {
            setWidth(Math.max(1, event.nativeEvent.layout.width));
            setFrameHeight(Math.max(44, event.nativeEvent.layout.height));
          }}
          onAccessibilityEscape={() => setSelected(null)}
        >
          {polar ? <PolarChart {...plotProps} /> : <CartesianChart {...plotProps} />}
          {active !== null ? (
            <View
              accessibilityLiveRegion="polite"
              onAccessibilityEscape={() => setSelected(null)}
              className="absolute left-0 right-0 top-0 z-10 rounded-md border border-border bg-card p-3"
              style={{ maxHeight: frameHeight }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close chart tooltip"
                onPress={() => setSelected(null)}
                className="absolute right-0 top-0 z-10 min-h-11 min-w-11 items-center justify-center"
              >
                <Text>×</Text>
              </Pressable>
              <ScrollView nestedScrollEnabled style={{ maxHeight: Math.max(20, frameHeight - 26) }}>
                <View className="gap-2">
                  <View className="min-h-8 pr-9">
                    <Text accessibilityRole="header" className="font-t3-bold text-sm">
                      {model.categories[active]}
                    </Text>
                    {chart.kind === "scatter" ? (
                      <Text className="text-xs text-foreground-muted">
                        {chart.xLabel ?? "X"}: {model.xValues[active]}
                      </Text>
                    ) : null}
                  </View>
                  {model.series.map((series, seriesIndex) => {
                    const value = model.values[active]?.[seriesIndex];
                    return (
                      <View
                        key={series.key}
                        className="flex-row flex-wrap justify-between gap-x-3 gap-y-1"
                      >
                        <View className="min-w-0 max-w-full flex-row items-center gap-2">
                          <View
                            style={{
                              width: 8,
                              height: 8,
                              backgroundColor:
                                colors[(circular ? active : seriesIndex) % colors.length],
                            }}
                          />
                          <Text className="min-w-0 shrink text-sm">{series.label}</Text>
                        </View>
                        <Text
                          selectable
                          className="ml-auto min-w-0 max-w-full text-right text-sm tabular-nums"
                        >
                          {value ?? "—"}
                          {value !== null && value !== undefined && chart.yLabel
                            ? ` ${chart.yLabel}`
                            : ""}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              </ScrollView>
            </View>
          ) : null}
        </View>
        {!polar && (chart.horizontal ? chart.yLabel : chart.xLabel) ? (
          <Text className="text-center text-xs text-foreground-muted">
            {chart.horizontal ? chart.yLabel : chart.xLabel}
          </Text>
        ) : null}
        <Disclosure
          title={`View data (${chart.points.length} ${chart.points.length === 1 ? "point" : "points"})`}
        >
          <View className="flex-row items-center justify-end gap-2">
            <Text accessibilityLiveRegion="polite" className="text-xs text-foreground-muted">
              {copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : ""}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Copy ${chart.title} data as CSV`}
              className="min-h-11 min-w-11 items-center justify-center"
              onPress={() => {
                void Clipboard.setStringAsync(chartCsv(chart)).then(
                  () => setCopyState("copied"),
                  () => setCopyState("error"),
                );
              }}
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" accessibilityElementsHidden>
                <Rect
                  x={8}
                  y={8}
                  width={12}
                  height={12}
                  rx={2}
                  fill="none"
                  stroke={foreground}
                  strokeWidth={1.5}
                />
                <Path
                  d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"
                  fill="none"
                  stroke={foreground}
                  strokeWidth={1.5}
                />
              </Svg>
            </Pressable>
          </View>
          <ScrollView horizontal accessibilityLabel={`${chart.title} data`}>
            <View>
              <View className="flex-row border-b border-border">
                {chart.kind === "scatter" ? (
                  <Text
                    accessibilityRole="header"
                    className="px-3 py-2 font-t3-bold text-sm"
                    style={{ width: 136 * fontScale }}
                  >
                    Label
                  </Text>
                ) : null}
                <Text
                  accessibilityRole="header"
                  className="px-3 py-2 font-t3-bold text-sm"
                  style={{ width: 136 * fontScale }}
                >
                  {chart.xLabel ?? (chart.kind === "scatter" ? "X" : "Category")}
                </Text>
                {chart.series.length > 0 ? (
                  <Text
                    accessibilityRole="header"
                    className="px-3 py-2 font-t3-bold text-sm"
                    style={{ width: 136 * fontScale }}
                  >
                    Series
                  </Text>
                ) : null}
                <Text
                  accessibilityRole="header"
                  className="px-3 py-2 font-t3-bold text-sm"
                  style={{ width: 136 * fontScale }}
                >
                  {chart.yLabel ?? "Value"}
                </Text>
              </View>
              {chart.points.map((point, index) => (
                <View key={index} className="flex-row border-t border-border">
                  {chart.kind === "scatter" ? (
                    <Text className="px-3 py-2 text-sm" style={{ width: 136 * fontScale }}>
                      {point.label}
                    </Text>
                  ) : null}
                  <Text className="px-3 py-2 text-sm" style={{ width: 136 * fontScale }}>
                    {chart.kind === "scatter" ? point.x : point.label}
                  </Text>
                  {chart.series.length > 0 ? (
                    <Text className="px-3 py-2 text-sm" style={{ width: 136 * fontScale }}>
                      {chart.series.find((series) => series.key === point.series)?.label ?? "Value"}
                    </Text>
                  ) : null}
                  <Text
                    selectable
                    className="px-3 py-2 text-sm tabular-nums"
                    style={{ width: 136 * fontScale }}
                  >
                    {point.value}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </Disclosure>
      </View>
    );
  },
  (previous, next) => JSON.stringify(previous.chart) === JSON.stringify(next.chart),
);

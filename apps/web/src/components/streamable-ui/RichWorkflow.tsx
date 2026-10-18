import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BaseEdge,
  Handle,
  type Node,
  type NodeProps,
  Controls,
  MarkerType,
  Position,
  ReactFlow,
  getViewportForBounds,
  useUpdateNodeInternals,
  type Edge,
  type EdgeProps,
  type ReactFlowInstance,
  type NodeChange,
} from "@xyflow/react";
import {
  CheckCircle2Icon,
  CircleDotIcon,
  CircleIcon,
  BanIcon,
  GitBranchIcon,
  PlayIcon,
  FlagIcon,
  WorkflowIcon,
} from "lucide-react";
import { useVisualReducedMotion, useVisualTextScale } from "./useVisualMotion";
import { routedEdgePath, workflowLayout } from "@t3tools/shared/streamableUiLayout";
import type { VisualWorkflow } from "@t3tools/shared/streamableUi";
import { observeResize } from "../../lib/observeResize";
import "@xyflow/react/dist/style.css";

type RoutedEdge = Edge<
  {
    points: Array<{ x: number; y: number }>;
    labelX: number | undefined;
    labelY: number | undefined;
  },
  "routed"
>;
const RoutedWorkflowEdge = memo(function RoutedWorkflowEdge({
  data,
  markerEnd,
  label,
  style,
}: EdgeProps<RoutedEdge>) {
  if (!data) return null;
  return (
    <BaseEdge
      path={routedEdgePath(data.points)}
      {...(markerEnd === undefined ? {} : { markerEnd })}
      label={label}
      {...(data.labelX === undefined ? {} : { labelX: data.labelX })}
      {...(data.labelY === undefined ? {} : { labelY: data.labelY })}
      labelStyle={{ fill: "var(--foreground)", fontSize: "0.75rem" }}
      labelBgStyle={{ fill: "var(--card)" }}
      labelBgPadding={[6, 4]}
      style={style}
    />
  );
});
type WorkflowPort = {
  id: string;
  type: "source" | "target";
  position: Position;
  x: number;
  y: number;
};
type WorkflowNodeType = Node<
  { step: VisualWorkflow["nodes"][number]; ports: WorkflowPort[] },
  "step"
>;
const states = {
  pending: { label: "Pending", icon: CircleIcon },
  active: { label: "In progress", icon: CircleDotIcon },
  complete: { label: "Complete", icon: CheckCircle2Icon },
  blocked: { label: "Blocked", icon: BanIcon },
};
const nodeKinds = {
  start: { label: "Start", icon: PlayIcon },
  step: { label: "Step", icon: WorkflowIcon },
  decision: { label: "Decision", icon: GitBranchIcon },
  end: { label: "End", icon: FlagIcon },
};
const WorkflowNode = memo(function WorkflowNode({ data, id }: NodeProps<WorkflowNodeType>) {
  const { step, ports } = data;
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    if (ports.length > 0) updateNodeInternals(id);
  }, [id, ports, updateNodeInternals]);
  const kind = nodeKinds[step.kind ?? "step"];
  const state = step.status ? states[step.status] : null;
  const StateIcon = state?.icon;
  return (
    <div
      data-workflow-kind={step.kind ?? "step"}
      data-workflow-status={step.status ?? "pending"}
      className="grid min-w-0 gap-1.5 p-3 text-left"
    >
      {ports.map((port) => (
        <Handle
          key={port.id}
          id={port.id}
          type={port.type}
          position={port.position}
          isConnectable={false}
          style={{
            // Dagre uses the border box; handles are positioned inside its 1px border.
            left: port.x - 1,
            top: port.y - 1,
            right: "auto",
            bottom: "auto",
            transform: "translate(-50%, -50%)",
          }}
        />
      ))}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <kind.icon aria-hidden className="size-3.5" />
          {kind.label}
        </span>
        {StateIcon ? <StateIcon aria-label={state?.label} className="size-3.5" /> : null}
      </div>
      <div className="text-sm font-medium leading-5 [overflow-wrap:anywhere]">{step.title}</div>
      {step.detail ? (
        <div className="text-xs leading-4 text-muted-foreground [overflow-wrap:anywhere]">
          {step.detail}
        </div>
      ) : null}
    </div>
  );
});
const nodeTypes = { step: WorkflowNode };
const edgeTypes = { routed: RoutedWorkflowEdge };

export const RichWorkflow = memo(
  function RichWorkflow({ workflow }: { workflow: VisualWorkflow }) {
    const reducedMotion = useVisualReducedMotion();
    const textScale = useVisualTextScale();
    const [measurements, setMeasurements] = useState({
      textScale,
      sizes: new Map<string, { width: number; height: number }>(),
    });
    const layout = workflowLayout(
      workflow,
      textScale,
      measurements.textScale === textScale ? measurements.sizes : undefined,
    );
    const measureNodes = (changes: NodeChange<WorkflowNodeType>[]) => {
      const dimensions = changes.filter((change) => change.type === "dimensions");
      if (dimensions.length === 0) return;
      setMeasurements((current) => {
        const sizes = new Map(current.textScale === textScale ? current.sizes : []);
        let changed = current.textScale !== textScale;
        for (const change of dimensions) {
          if (!change.dimensions) continue;
          const previous = sizes.get(change.id);
          const { width, height } = change.dimensions;
          if (
            previous &&
            Math.abs(previous.width - width) < 0.5 &&
            Math.abs(previous.height - height) < 0.5
          )
            continue;
          sizes.set(change.id, { width, height });
          changed = true;
        }
        return changed ? { textScale, sizes } : current;
      });
    };
    const [instance, setInstance] = useState<ReactFlowInstance<WorkflowNodeType, RoutedEdge>>();
    const [selected, setSelected] = useState<string>();
    const [container, setContainer] = useState<HTMLDivElement | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const userMoved = useRef(false);
    useEffect(() => {
      if (!container) return;
      return observeResize(container, ([entry]) => {
        if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      });
    }, [container]);
    const fittedViewport = getViewportForBounds(
      { x: 0, y: 0, width: layout.width, height: layout.height },
      Math.max(1, size.width),
      Math.max(1, size.height),
      0.15,
      1,
      0.1,
    );
    const nodes = layout.nodes.map((node) => ({
      id: node.key,
      position: { x: node.x, y: node.y },
      type: "step" as const,
      data: {
        step: node,
        ports: layout.edges.flatMap((edge) => {
          const source = edge.from === node.key,
            target = edge.to === node.key;
          if (!source && !target) return [];
          const point = source ? edge.points[0]! : edge.points.at(-1)!;
          const x = point.x - node.x,
            y = point.y - node.y;
          const distances = [
            Math.abs(x),
            Math.abs(x - node.width),
            Math.abs(y),
            Math.abs(y - node.height),
          ];
          const sides = [Position.Left, Position.Right, Position.Top, Position.Bottom];
          return [
            {
              id: `${edge.key}-${source ? "source" : "target"}`,
              type: source ? ("source" as const) : ("target" as const),
              position: sides[distances.indexOf(Math.min(...distances))]!,
              x,
              y,
            },
          ];
        }),
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
      selected: selected === node.key,
      ariaLabel: node.title,
      draggable: false,
      connectable: false,
      style: { width: 184 * textScale, minHeight: 80 * textScale },
    }));
    const edges: RoutedEdge[] = layout.edges.map((edge) => ({
      id: edge.key,
      source: edge.from,
      target: edge.to,
      sourceHandle: `${edge.key}-source`,
      targetHandle: `${edge.key}-target`,
      type: "routed",
      label: edge.label,
      ariaLabel: `${workflow.nodes.find((node) => node.key === edge.from)!.title} to ${workflow.nodes.find((node) => node.key === edge.to)!.title}${edge.label ? `: ${edge.label}` : ""}`,
      data: { points: edge.points, labelX: edge.labelX, labelY: edge.labelY },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: "var(--primary)",
        width: 18,
        height: 18,
      },
      style: { stroke: "var(--primary)", strokeWidth: 1.6 },
      deletable: false,
      animated: false,
    }));
    useLayoutEffect(() => {
      if (instance && size.width > 0 && !userMoved.current)
        void instance.setViewport(fittedViewport, { duration: 0 });
    }, [instance, fittedViewport, size.width]);
    const detail = workflow.nodes.find((node) => node.key === selected);
    return (
      <div className="grid min-w-0 gap-3">
        <div
          ref={setContainer}
          data-iui-workflow=""
          className="relative min-w-0 rounded-md border border-border"
          style={{ height: "min(32.5rem, 70dvh)" }}
          aria-label={workflow.title}
        >
          <ReactFlow
            nodes={nodes}
            nodeTypes={nodeTypes}
            edges={edges}
            edgeTypes={edgeTypes}
            onInit={setInstance}
            onNodesChange={measureNodes}
            onMoveStart={(event) => {
              if (event) userMoved.current = true;
            }}
            onNodeClick={(_, node) => setSelected(node.id)}
            onSelectionChange={({ nodes: selectedNodes }) => {
              if (selectedNodes[0]) setSelected(selectedNodes[0].id);
            }}
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable
            edgesFocusable
            deleteKeyCode={null}
            zoomOnScroll={false}
            panOnScroll={false}
            panOnDrag
            preventScrolling={false}
            zoomOnPinch
            minZoom={0.15}
            maxZoom={2}
            autoPanOnNodeFocus
            ariaLabelConfig={{
              "node.a11yDescription.default": "Press Enter to select this step.",
              "edge.a11yDescription.default": "Directed connection.",
            }}
          >
            <Controls
              showInteractive={false}
              onZoomIn={() => {
                userMoved.current = true;
              }}
              onZoomOut={() => {
                userMoved.current = true;
              }}
              onFitView={() => {
                userMoved.current = false;
                void instance?.setViewport(fittedViewport, { duration: reducedMotion ? 0 : 220 });
              }}
            />
          </ReactFlow>
          {workflow.nodes.length === 0 ? (
            <p
              role="status"
              className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted-foreground"
            >
              Waiting for steps…
            </p>
          ) : null}
        </div>
        {detail ? (
          <div className="grid gap-2 rounded-md border border-border p-3">
            <p className="text-sm font-medium [overflow-wrap:anywhere]">{detail.title}</p>
            {detail.detail ? (
              <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {detail.detail}
              </p>
            ) : null}
            {workflow.edges
              .filter((edge) => edge.from === detail.key)
              .map((edge) => (
                <p key={edge.key} className="text-xs text-muted-foreground">
                  → {workflow.nodes.find((node) => node.key === edge.to)!.title}
                  {edge.label ? ` · ${edge.label}` : ""}
                </p>
              ))}
          </div>
        ) : null}
        <details>
          <summary className="cursor-pointer text-xs underline focus-visible:outline-2 focus-visible:outline-ring">
            View steps ({workflow.nodes.length})
          </summary>
          <ol className="grid gap-3 pt-3">
            {workflow.nodes.map((node, index) => (
              <li key={node.key} className="grid gap-1 text-sm">
                <p className="font-medium">
                  {index + 1}. {node.title}
                </p>
                {node.detail ? <p className="text-muted-foreground">{node.detail}</p> : null}
                {workflow.edges
                  .filter((edge) => edge.from === node.key)
                  .map((edge) => (
                    <p key={edge.key} className="text-xs text-muted-foreground">
                      → {workflow.nodes.find((target) => target.key === edge.to)!.title}
                      {edge.label ? ` · ${edge.label}` : ""}
                    </p>
                  ))}
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  },
  (previous, next) => JSON.stringify(previous.workflow) === JSON.stringify(next.workflow),
);

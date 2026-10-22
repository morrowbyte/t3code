import { useEffect, useRef, useState } from "react";
import {
  Background,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Node,
  type NodeProps,
  type Viewport,
  type EdgeProps,
} from "@xyflow/react";
import type { ReviewBundle, ReviewStep } from "@t3tools/client-runtime/approvalReview";
import { Button } from "../ui/button";
import "@xyflow/react/dist/style.css";
import styles from "./approvalReview.module.css";
import { activityLayout } from "./ReviewActivity.layout";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useMediaQuery } from "../../hooks/useMediaQuery";

type ActivityNode = Node<{ step: ReviewStep; ordinal: number }, "activity">;
function ActivityNodeView({ data, selected }: NodeProps<ActivityNode>) {
  const kind = data.step.kind ?? "step";
  return (
    <div
      className={`${styles["review-activity-node"]} ${styles[`review-activity-${kind}`]} ${selected ? styles["is-selected"] : ""}`}
    >
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((position) => (
        <Handle
          key={`target-${position}`}
          id={`target-${position}`}
          type="target"
          position={position}
        />
      ))}
      <span className={styles["review-node-number"]}>
        {kind === "start" ? "●" : kind === "end" ? "◉" : String(data.ordinal).padStart(2, "0")}
      </span>
      <div>
        <span className={styles["review-node-kind"]}>
          {kind === "decision"
            ? "Decision"
            : kind === "fork"
              ? "Fork"
              : kind === "join"
                ? "Join"
                : kind === "start"
                  ? "Start"
                  : kind === "end"
                    ? "End"
                    : "Proposed step"}
        </span>
        <strong>{data.step.title}</strong>
      </div>
      {[Position.Top, Position.Right, Position.Bottom, Position.Left].map((position) => (
        <Handle
          key={`source-${position}`}
          id={`source-${position}`}
          type="source"
          position={position}
        />
      ))}
    </div>
  );
}
const nodeTypes = { activity: ActivityNodeView };
function GuardEdge(props: EdgeProps) {
  const left = props.sourceX < 100;
  const lane = left ? -16 : 685;
  const path = left
    ? `M ${props.sourceX} ${props.sourceY} H ${lane} V -18 H 685 V ${props.targetY} H ${props.targetX}`
    : `M ${props.sourceX} ${props.sourceY} H ${lane} V ${props.targetY} H ${props.targetX}`;
  return (
    <BaseEdge
      id={props.id}
      {...(props.markerEnd === undefined ? {} : { markerEnd: props.markerEnd })}
      path={path}
      style={{ stroke: "var(--warning)", strokeWidth: 1, strokeDasharray: "4 4", opacity: 0.6 }}
    />
  );
}
const edgeTypes = { guard: GuardEdge };
const viewports = new Map<string, Viewport>();

function ActivityCanvas({
  bundle,
  selectedId,
  onSelect,
  onSource,
  active,
  sessionKey,
}: {
  bundle: ReviewBundle;
  selectedId: string;
  onSelect: (id: string) => void;
  onSource: () => void;
  active: boolean;
  sessionKey: string;
}) {
  const flow = useReactFlow<ActivityNode>();
  const controlSize = useMediaQuery("max-sm") ? "xl" : "sm";
  const container = useRef<HTMLDivElement>(null);
  const previousSelection = useRef(selectedId);
  const [expanded, setExpanded] = useState(false);
  const selectedIsDecision = bundle.steps.some(
    (step) => step.id === selectedId && step.kind === "decision",
  );
  const layout = activityLayout(bundle, expanded || selectedIsDecision);
  const nodes = layout.steps.map((step, index): ActivityNode => ({
    id: step.id,
    type: "activity",
    data: { step, ordinal: index + 1 },
    position: layout.positions.get(step.id)!,
    selected: step.id === selectedId,
    draggable: false,
    connectable: false,
    ariaLabel: `${index + 1}. ${step.title}`,
    style: { width: layout.positions.get(step.id)!.width },
  }));
  const edges = layout.edges.map((edge, index) => {
    const from = layout.positions.get(edge.from)!;
    const to = layout.positions.get(edge.to)!;
    const horizontal = from.y === to.y;
    const outcome = to.width === 200;
    const sourceSide = horizontal ? (from.x < to.x ? "right" : "left") : "bottom";
    const targetSide = horizontal ? (from.x < to.x ? "left" : "right") : "top";
    return {
      id: `edge-${index}`,
      source: edge.from,
      target: edge.to,
      label: outcome || !expanded ? undefined : edge.label,
      ariaLabel: `${edge.from} → ${edge.to}: ${edge.label ?? "next"}`,
      sourceHandle: `source-${outcome ? (from.x === 0 ? "left" : "right") : sourceSide}`,
      targetHandle: `target-${outcome ? "left" : targetSide}`,
      markerEnd: { type: MarkerType.ArrowClosed },
      type: outcome ? "guard" : "smoothstep",
      style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
      labelStyle: { fill: "var(--foreground)", fontSize: 12 },
      labelBgStyle: { fill: "var(--background)" },
    };
  });
  const reveal = useStableCallback(() => {
    const node = nodes.find((entry) => entry.id === selectedId);
    if (node)
      void flow.setCenter(node.position.x + Number(node.style?.width) / 2, node.position.y + 55, {
        zoom: 1,
        duration: 0,
      });
  });
  useEffect(() => {
    if (!active || previousSelection.current === selectedId) return;
    previousSelection.current = selectedId;
    const node = nodes.find((entry) => entry.id === selectedId);
    if (node)
      void flow.setCenter(node.position.x + Number(node.style?.width) / 2, node.position.y + 55, {
        zoom: 1,
        duration: 0,
      });
  }, [selectedId, nodes, flow, active]);
  const move = (direction: number) => {
    const index = layout.steps.findIndex((step) => step.id === selectedId);
    const step = layout.steps[Math.max(0, Math.min(layout.steps.length - 1, index + direction))];
    if (step) onSelect(step.id);
  };
  return (
    <div
      className={styles["review-activity"]}
      ref={container}
      data-keyboard-local="true"
      onFocusCapture={(event) => {
        const node = event.target.closest<HTMLElement>(".react-flow__node");
        if (node?.dataset.id && node.dataset.id !== selectedId) onSelect(node.dataset.id);
      }}
      onKeyDown={(event) => {
        if (
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.target instanceof HTMLButtonElement
        )
          return;
        const pan: Record<string, [number, number]> = {
          h: [90, 0],
          ArrowLeft: [90, 0],
          l: [-90, 0],
          ArrowRight: [-90, 0],
          k: [0, 90],
          ArrowUp: [0, 90],
          j: [0, -90],
          ArrowDown: [0, -90],
        };
        if (pan[event.key]) {
          const viewport = flow.getViewport();
          const delta = pan[event.key]!;
          void flow.setViewport({
            ...viewport,
            x: viewport.x + delta[0],
            y: viewport.y + delta[1],
          });
        } else if (event.key === "n" || event.key === "]") move(1);
        else if (event.key === "p" || event.key === "[") move(-1);
        else if (event.key === "+" || event.key === "=") void flow.zoomIn();
        else if (event.key === "-") void flow.zoomOut();
        else if (event.key === "0") reveal();
        else if (event.key === "f") void flow.fitView({ padding: 0.2 });
        else if (event.key === "Enter") onSource();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className={styles["review-graph-toolbar"]} aria-label="Diagram controls">
        <Button
          variant="outline"
          size={controlSize}
          onClick={() => move(-1)}
          aria-label="Previous step"
        >
          ←
        </Button>
        <Button variant="outline" size={controlSize} onClick={() => move(1)} aria-label="Next step">
          →
        </Button>
        <Button
          variant="outline"
          size={controlSize}
          onClick={() => void flow.zoomOut()}
          aria-label="Zoom out"
        >
          −
        </Button>
        <Button
          variant="outline"
          size={controlSize}
          onClick={() => void flow.zoomIn()}
          aria-label="Zoom in"
        >
          +
        </Button>
        <Button variant="outline" size={controlSize} onClick={reveal}>
          Selected step
        </Button>
        <Button
          variant="outline"
          size={controlSize}
          onClick={() => void flow.fitView({ padding: 0.2 })}
        >
          Overview
        </Button>
        <Button
          variant="outline"
          size={controlSize}
          aria-pressed={expanded || selectedIsDecision}
          onClick={() => {
            if (selectedIsDecision)
              onSelect(bundle.steps.find((step) => step.kind !== "decision")!.id);
            setExpanded(!expanded);
          }}
        >
          {expanded || selectedIsDecision ? "Hide decisions" : "Show decisions"}
        </Button>
      </div>
      <div
        className={styles["review-graph-canvas"]}
        tabIndex={0}
        role="group"
        aria-label="Activity diagram. N and P select steps; arrow keys or H J K L pan; plus and minus zoom; zero reveals selection; Enter opens source."
      >
        <ReactFlow<ActivityNode>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onInit={() =>
            void flow.setViewport(viewports.get(sessionKey) ?? { x: 20, y: 24, zoom: 1 })
          }
          onMoveEnd={(_, viewport) => {
            viewports.delete(sessionKey);
            viewports.set(sessionKey, viewport);
            if (viewports.size > 12) viewports.delete(viewports.keys().next().value!);
          }}
          onNodeClick={(_, node) => onSelect(node.id)}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          disableKeyboardA11y
          minZoom={0.15}
          maxZoom={2}
          defaultViewport={{ x: 70, y: 90, zoom: 1 }}
          preventScrolling
          autoPanOnNodeFocus
        >
          <Background gap={24} size={1} color="var(--border)" />
        </ReactFlow>
      </div>
      <div className={styles["review-graph-keyhelp"]}>
        N / P steps · H J K L pan · + − zoom · 0 selected · F overview · Enter source
      </div>
    </div>
  );
}

export function ReviewActivity(props: Parameters<typeof ActivityCanvas>[0]) {
  return (
    <ReactFlowProvider>
      <ActivityCanvas {...props} />
    </ReactFlowProvider>
  );
}

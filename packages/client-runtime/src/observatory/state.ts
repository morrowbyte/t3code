import type { OrchestrationV2ThreadShell, ScopedThreadRef } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { deadlineStore } from "../clock.ts";
import type { EnvironmentThreadState } from "../state/threads.ts";
import { createObservatoryAuthoredProjector, observedObservatoryOwner } from "./authored.ts";
import { projectObservatoryTask } from "./tasks.ts";
import {
  observatoryKey,
  observatoryNode,
  projectObservatoryDetails,
  projectObservatoryNative,
  projectObservatoryPage,
  EMPTY_OBSERVATORY_QUERY,
  type ObservatoryQuery,
  type ObservatoryEnvironment,
} from "./native.ts";

/** These are captured READ facts from an authorized service adapter, not a serialized trust flag. */
export interface ObservatoryAuthoredSource {
  readonly generation: number;
  readonly read: unknown;
  readonly checkpointReached: unknown;
}
export function createObservatoryViewAtoms(input: {
  readonly catalogReadyAtom: Atom.Atom<boolean>;
  readonly sourcesAtom: Atom.Atom<readonly ObservatoryEnvironment[]>;
  readonly selectedAtom: Atom.Writable<ScopedThreadRef | null>;
  readonly detailAtom: (ref: ScopedThreadRef) => Atom.Atom<EnvironmentThreadState | null>;
  readonly familyAtom?: (ref: ScopedThreadRef) => Atom.Atom<readonly OrchestrationV2ThreadShell[]>;
  readonly authoredAtom?: (ref: ScopedThreadRef) => Atom.Atom<ObservatoryAuthoredSource | null>;
  readonly taskCards?: boolean;
}) {
  const queryAtom = Atom.make<ObservatoryQuery>(EMPTY_OBSERVATORY_QUERY);
  const observationTimeAtom = Atom.make((get) => {
    const nowMs = Clock.Clock.defaultValue().currentTimeMillisUnsafe();
    let nextWake = Infinity;
    for (const source of get(input.sourcesAtom)) {
      const snapshot = source.shell === null ? null : Option.getOrNull(source.shell.snapshot);
      for (const thread of snapshot?.threads ?? []) {
        if (thread.snoozedUntil == null) continue;
        const wake = DateTime.toEpochMillis(thread.snoozedUntil);
        if (wake > nowMs) nextWake = Math.min(nextWake, wake);
      }
    }
    if (Number.isFinite(nextWake)) {
      get.addFinalizer(deadlineStore(nextWake).subscribe(() => get.refreshSelf()));
    }
    return nowMs;
  });
  // Retire the current selection intent when its authorized live shell disappears.
  const invalidatedSelection = new WeakMap<AtomRegistry.AtomRegistry, ScopedThreadRef>();
  const authored = new WeakMap<
    AtomRegistry.AtomRegistry,
    {
      key: string;
      generation: number;
      project: ReturnType<typeof createObservatoryAuthoredProjector>;
    }
  >();
  const selectionAtom = Atom.make((get) => {
    const selected = get(input.selectedAtom);
    if (selected === null) invalidatedSelection.delete(get.registry);
    if (selected !== null && invalidatedSelection.get(get.registry) === selected) return null;
    const sources = get(input.sourcesAtom);
    const graph = projectObservatoryNative(sources);
    const node =
      selected === null
        ? undefined
        : graph.nodes.find((node) => node.key === observatoryKey(selected));
    const source =
      node === undefined
        ? undefined
        : sources.find((source) => source.environmentId === node.ref.environmentId);
    if (!node || !source) {
      if (selected !== null) invalidatedSelection.set(get.registry, selected);
      authored.delete(get.registry);
      return null;
    }
    const detail = projectObservatoryDetails(node, source, get(input.detailAtom(node.ref)));
    const family = input.familyAtom ? get(input.familyAtom(node.ref)) : [];
    const related = [
      ...graph.nodes,
      ...family
        .filter(
          (thread) =>
            !graph.nodes.some(
              (candidate) =>
                candidate.ref.environmentId === node.ref.environmentId &&
                candidate.ref.threadId === thread.id,
            ),
        )
        .map((thread) => observatoryNode(node.ref.environmentId, thread)),
    ];
    let context = authored.get(get.registry);
    if (!context || context.key !== node.key || context.generation !== source.generation) {
      context = {
        key: node.key,
        generation: source.generation,
        project: createObservatoryAuthoredProjector(),
      };
      authored.set(get.registry, context);
    }
    const read = input.authoredAtom ? get(input.authoredAtom(node.ref)) : null;
    const visual =
      detail === null || read === null || read.generation !== source.generation
        ? context.project(null, null)
        : context.project(
            observedObservatoryOwner(source.environmentId, node, detail),
            read.read,
            read.checkpointReached,
          );
    return {
      node,
      source,
      detail,
      visual,
      task: projectObservatoryTask(node, related, detail, get(observationTimeAtom)),
    };
  });
  const snapshotAtom = Atom.make((get) => {
    const sources = get(input.sourcesAtom);
    const graph = projectObservatoryNative(sources);
    const selection = get(selectionAtom);
    const nodes = graph.nodes.map((node) =>
      selection?.node.key === node.key && selection.visual.status === "ready"
        ? {
            ...node,
            title: selection.visual.snapshot.state.title,
            authoredRevision: selection.visual.snapshot.revision,
          }
        : { ...node, authoredRevision: null },
    );
    const page = projectObservatoryPage(
      { ...graph, nodes },
      get(queryAtom),
      input.taskCards ? 12 : undefined,
      input.taskCards,
      get(observationTimeAtom),
    );
    const related = new Map(graph.nodes.map((node) => [node.key, node]));
    if (input.familyAtom) {
      for (const node of page.nodes) {
        for (const thread of get(input.familyAtom(node.ref))) {
          const relative = observatoryNode(node.ref.environmentId, thread);
          if (!related.has(relative.key)) related.set(relative.key, relative);
        }
      }
    }
    return {
      ...page,
      nodes: page.nodes.map((node) => {
        const source = sources.find((source) => source.environmentId === node.ref.environmentId)!;
        const detail = input.taskCards
          ? projectObservatoryDetails(node, source, get(input.detailAtom(node.ref)))
          : selection?.node.key === node.key
            ? selection.detail
            : null;
        return {
          ...node,
          task: projectObservatoryTask(
            node,
            [...related.values()],
            detail,
            get(observationTimeAtom),
          ),
        };
      }),
      catalogReady: get(input.catalogReadyAtom),
      selection,
    };
  });
  // Choosing even the same thread explicitly creates a fresh intent after grant loss.
  const selectedAtom = Atom.writable(
    (get) => get(selectionAtom)?.node.ref ?? null,
    (context, ref: ScopedThreadRef | null) =>
      context.set(input.selectedAtom, ref === null ? null : { ...ref }),
  );
  return { snapshotAtom, selectedAtom, queryAtom };
}
export type ObservatoryView = Atom.Type<
  ReturnType<typeof createObservatoryViewAtoms>["snapshotAtom"]
>;

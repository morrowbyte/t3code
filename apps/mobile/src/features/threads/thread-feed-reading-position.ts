import { resolveWorkGroupScrollAnchor } from "@t3tools/client-runtime/work-log/scroll-anchor";
import type { RunId } from "@t3tools/contracts";
import type {
  ThreadFeedReflowLayout,
  ThreadFeedReflowListState,
  ThreadFeedReflowRowAnchor,
  ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";

type ReadingListState = Pick<
  ThreadFeedReflowListState,
  "data" | "scroll" | "indexByKey" | "positionAtIndex" | "sizes"
> & { readonly isAtEnd: boolean };

type ReadingLayout = ThreadFeedReflowLayout & { readonly viewportWidth: number };

export interface ThreadFeedReadingPosition {
  readonly following: boolean;
  readonly anchor: ThreadFeedReflowRowAnchor;
  readonly nearbyKeys: ReadonlyArray<string>;
  readonly index: number;
  readonly viewportWidth: number;
  readonly historyEntryId?: string;
  readonly workGroupScrollPositions?: Map<string, ThreadWorkGroupScrollPosition>;
  readonly disclosures?: {
    readonly expandedWorkGroups: Record<string, boolean>;
    readonly expandedWorkRows: Record<string, boolean>;
    readonly expandedTurnIds: ReadonlySet<RunId>;
  };
}

export function createThreadFeedReadingPositions(limit = 64) {
  const positions = new Map<string, ThreadFeedReadingPosition>();
  const keyOf = (environmentId: string, threadId: string) =>
    JSON.stringify([environmentId, threadId]);
  return {
    get(environmentId: string, threadId: string) {
      const key = keyOf(environmentId, threadId);
      const position = positions.get(key);
      if (position) {
        positions.delete(key);
        positions.set(key, position);
      }
      return position;
    },
    set(environmentId: string, threadId: string, position: ThreadFeedReadingPosition) {
      const key = keyOf(environmentId, threadId);
      positions.delete(key);
      positions.set(key, position);
      if (positions.size > Math.max(1, limit)) {
        const oldest = positions.keys().next().value;
        if (oldest !== undefined) positions.delete(oldest);
      }
    },
    setDisclosures(
      environmentId: string,
      threadId: string,
      disclosures: NonNullable<ThreadFeedReadingPosition["disclosures"]>,
      workGroupScrollPositions: Map<string, ThreadWorkGroupScrollPosition>,
    ) {
      const key = keyOf(environmentId, threadId);
      const position = positions.get(key);
      if (position) {
        positions.set(key, { ...position, disclosures, workGroupScrollPositions });
      }
    },
  };
}

export const threadFeedReadingPositions = createThreadFeedReadingPositions();

export function captureThreadFeedReadingPosition(
  state: ReadingListState,
  layout: ReadingLayout,
  following: boolean,
  disclosures?: ThreadFeedReadingPosition["disclosures"],
  workGroupScrollPositions?: Map<string, ThreadWorkGroupScrollPosition>,
): ThreadFeedReadingPosition | undefined {
  const readingLine = state.scroll + layout.headerInset - layout.rowsTop;
  const row = resolveWorkGroupScrollAnchor({
    data: state.data,
    scroll: readingLine,
    positionAtIndex: state.positionAtIndex,
  });
  if (!row) return undefined;
  const index = state.indexByKey(row.rowId);
  if (index === undefined) return undefined;
  return {
    following: following && state.isAtEnd,
    anchor: {
      key: row.rowId,
      offsetWithinRow: readingLine < 0 ? readingLine : row.offsetWithinRow,
      size: Math.max(1, state.sizes.get(row.rowId) ?? 180),
    },
    nearbyKeys: [index + 1, index - 1, index + 2, index - 2].flatMap((nearbyIndex) => {
      const nearby = state.data[nearbyIndex];
      return nearby ? [nearby.id] : [];
    }),
    index,
    viewportWidth: layout.viewportWidth,
    ...(disclosures ? { disclosures } : {}),
    ...(workGroupScrollPositions ? { workGroupScrollPositions } : {}),
  };
}

export function resolveThreadFeedReadingScroll(
  position: ThreadFeedReadingPosition,
  state: Pick<ReadingListState, "data" | "indexByKey" | "sizes">,
  layout: ReadingLayout,
): { readonly index: number; readonly viewOffset: number } | undefined {
  if (state.data.length === 0) return undefined;
  const anchorIndex = state.indexByKey(position.anchor.key);
  const nearbyIndex = position.nearbyKeys
    .map((key) => state.indexByKey(key))
    .find((index) => index !== undefined);
  const index = anchorIndex ?? nearbyIndex ?? Math.min(position.index, state.data.length - 1);
  const size = state.sizes.get(position.anchor.key) ?? position.anchor.size;
  const offset =
    anchorIndex === undefined
      ? 0
      : Math.min(
          Math.max(0, size - 1),
          position.anchor.offsetWithinRow *
            (layout.viewportWidth === position.viewportWidth ? 1 : size / position.anchor.size),
        );
  return { index, viewOffset: layout.headerInset - offset };
}

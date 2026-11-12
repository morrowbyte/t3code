import { describe, expect, it } from "vite-plus/test";
import { RunId } from "@t3tools/contracts";

import {
  captureThreadFeedReadingPosition,
  createThreadFeedReadingPositions,
  resolveThreadFeedReadingScroll,
} from "./thread-feed-reading-position";
import {
  resolveThreadWorkGroupInitialScroll,
  type ThreadWorkGroupScrollPosition,
} from "./thread-feed-live-follow";

function feedState(ids: ReadonlyArray<string>, scroll = 140, size = 100, isAtEnd = false) {
  return {
    data: ids.map((id) => ({ id })),
    scroll,
    isAtEnd,
    sizes: new Map(ids.map((id) => [id, size])),
    indexByKey: (key: string) => {
      const index = ids.indexOf(key);
      return index < 0 ? undefined : index;
    },
    positionAtIndex: (index: number) => index * size,
  };
}

const layout = { rowsTop: 20, headerInset: 30, viewportWidth: 400 };

describe("native thread reading positions", () => {
  it("restores A after reading B without sharing positions across environments", () => {
    const positions = createThreadFeedReadingPositions();
    const disclosures = {
      expandedWorkGroups: { build: true },
      expandedWorkRows: { command: true },
      expandedTurnIds: new Set([RunId.make("run-a")]),
    };
    const workGroupScrollPositions = new Map([
      ["build", { rowId: "command", offsetWithinRow: 12, scrollOffset: 112, contentHeight: 700 }],
    ]);
    const a = captureThreadFeedReadingPosition(
      feedState(["a", "b", "c"]),
      layout,
      false,
      disclosures,
      workGroupScrollPositions,
    )!;
    const b = captureThreadFeedReadingPosition(feedState(["x", "y", "z"], 0), layout, false)!;
    positions.set("environment-one", "A", a);
    workGroupScrollPositions.set("build", {
      rowId: "next-command",
      offsetWithinRow: 24,
      scrollOffset: 224,
      contentHeight: 900,
    });
    positions.set("environment-one", "B", b);
    expect(positions.get("environment-one", "A")).toEqual(a);
    expect(positions.get("environment-one", "A")?.disclosures).toEqual(disclosures);
    expect(
      resolveThreadWorkGroupInitialScroll(
        [{ id: "command" }, { id: "next-command" }],
        positions.get("environment-one", "A")?.workGroupScrollPositions?.get("build"),
      ),
    ).toEqual({ index: 1, viewOffset: -24 });
    expect(positions.get("environment-one", "B")?.workGroupScrollPositions).toBeUndefined();
    expect(positions.get("environment-one", "B")).toEqual(b);
    expect(positions.get("environment-two", "A")).toBeUndefined();
    expect(
      resolveThreadFeedReadingScroll(a, feedState(["older", "a", "b", "c", "new"]), layout),
    ).toEqual({ index: 2, viewOffset: -20 });
    expect(resolveThreadFeedReadingScroll(a, feedState(["b", "a", "c"]), layout)).toEqual({
      index: 0,
      viewOffset: -20,
    });
  });

  it("persists disclosure changes without replacing the anchor during their layout transition", () => {
    const positions = createThreadFeedReadingPositions();
    const position = captureThreadFeedReadingPosition(feedState(["a", "b", "c"]), layout, false)!;
    const workGroupScrollPositions = new Map<string, ThreadWorkGroupScrollPosition>();
    positions.set("one", "A", { ...position, historyEntryId: "older-message" });
    positions.set("one", "B", position);
    for (const expanded of [true, false]) {
      const disclosures = {
        expandedWorkGroups: { build: expanded },
        expandedWorkRows: { command: expanded },
        expandedTurnIds: new Set(expanded ? [RunId.make("run-a")] : []),
      };
      positions.setDisclosures("one", "A", disclosures, workGroupScrollPositions);
      expect(positions.get("one", "A")).toEqual({
        ...position,
        historyEntryId: "older-message",
        disclosures,
        workGroupScrollPositions,
      });
      expect(positions.get("one", "B")).toEqual(position);
      expect(positions.get("two", "A")).toBeUndefined();
    }
  });

  it("keeps the read line through appends and rewraps only for a changed width", () => {
    const position = captureThreadFeedReadingPosition(feedState(["a", "b", "c"]), layout, false)!;
    expect(
      resolveThreadFeedReadingScroll(position, feedState(["a", "b", "c"], 0, 200), layout),
    ).toEqual({ index: 1, viewOffset: -20 });
    expect(
      resolveThreadFeedReadingScroll(position, feedState(["a", "b", "c"], 0, 200), {
        ...layout,
        viewportWidth: 200,
      }),
    ).toEqual({ index: 1, viewOffset: -70 });
  });

  it("uses the nearest surviving row when the anchor is deleted, then a bounded index fallback", () => {
    const position = captureThreadFeedReadingPosition(feedState(["a", "b", "c"]), layout, false)!;
    expect(
      resolveThreadFeedReadingScroll(position, feedState(["older", "a", "c"]), layout),
    ).toEqual({ index: 2, viewOffset: 30 });
    expect(resolveThreadFeedReadingScroll(position, feedState(["replacement"]), layout)).toEqual({
      index: 0,
      viewOffset: 30,
    });
    expect(resolveThreadFeedReadingScroll(position, feedState([]), layout)).toBeUndefined();
  });

  it("retains follow only when the reader actually reached the end, including short feeds", () => {
    expect(
      captureThreadFeedReadingPosition(feedState(["a"], 0, 100, true), layout, true)?.following,
    ).toBe(true);
    expect(
      captureThreadFeedReadingPosition(feedState(["a", "b", "c"]), layout, true)?.following,
    ).toBe(false);
    expect(
      captureThreadFeedReadingPosition(feedState(["a"], 0, 100, true), layout, false)?.following,
    ).toBe(false);
    expect(captureThreadFeedReadingPosition(feedState([]), layout, true)).toBeUndefined();
  });

  it("keeps a reader at the first row and clamps an offset after content shrinks", () => {
    const top = captureThreadFeedReadingPosition(feedState(["a", "b"], -30), layout, false)!;
    expect(resolveThreadFeedReadingScroll(top, feedState(["a", "b"]), layout)).toEqual({
      index: 0,
      viewOffset: 30,
    });
    const position = captureThreadFeedReadingPosition(feedState(["a", "b", "c"]), layout, false)!;
    expect(
      resolveThreadFeedReadingScroll(position, feedState(["a", "b", "c"], 0, 20), layout),
    ).toEqual({ index: 1, viewOffset: 11 });
  });

  it("bounds retention and refreshes a revisited thread before evicting the oldest", () => {
    const positions = createThreadFeedReadingPositions(2);
    const position = captureThreadFeedReadingPosition(feedState(["a"]), layout, false)!;
    positions.set("one", "A", position);
    positions.set("one", "B", position);
    positions.get("one", "A");
    positions.set("one", "C", position);
    expect(positions.get("one", "A")).toEqual(position);
    expect(positions.get("one", "B")).toBeUndefined();
    expect(positions.get("one", "C")).toEqual(position);
  });
});

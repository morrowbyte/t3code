import { expect, it } from "vite-plus/test";
import { createUmlSnapshotQueue } from "./streamableUml.ts";
import type { UmlRenderResult } from "@t3tools/contracts";

it("finishes the first useful snapshot during append, retains it on failure, and ignores completion after disposal", async () => {
  const pending: Array<{
    source: string;
    resolve: (result: UmlRenderResult) => void;
    signal: AbortSignal;
  }> = [];
  const results: UmlRenderResult[] = [];
  const queue = createUmlSnapshotQueue({
    render: (source, signal) => new Promise((resolve) => pending.push({ source, resolve, signal })),
    onResult: (result) => results.push(result),
  });
  queue.update([{ source: "first" }]);
  queue.update([{ source: "first" }, { source: "next" }]);
  expect(pending.map((p) => p.source)).toEqual(["first"]);
  const first = { status: "ready", svg: "<svg/>", width: 100, height: 100 } as const;
  pending[0]!.resolve(first);
  await Promise.resolve();
  expect(results).toEqual([first]);
  expect(pending.map((p) => p.source)).toEqual(["first", "next"]);
  pending[1]!.resolve({ status: "unavailable", reason: "invalid" });
  await Promise.resolve();
  expect(results).toEqual([first, { status: "unavailable", reason: "invalid" }]);
  queue.update([{ source: "last" }]);
  queue.dispose();
  expect(pending[2]!.signal.aborted).toBe(true);
  pending[2]!.resolve(first);
  await Promise.resolve();
  expect(results).toHaveLength(2);
});

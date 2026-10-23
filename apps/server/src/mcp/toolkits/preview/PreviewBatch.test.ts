import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  PreviewTabId,
  type PreviewAutomationStatus,
  type PreviewAutomationSnapshot,
} from "@t3tools/contracts";
import { executePreviewBatch, PreviewBatchInput, type PreviewBatchStep } from "./PreviewBatch.ts";

const tabId = PreviewTabId.make("owned-tab"),
  origin = "http://127.0.0.1:3321";
const state = { url: origin + "/saved" } as PreviewAutomationSnapshot;
const status = {
  available: true,
  visible: false,
  tabId,
  url: origin + "/edit",
  title: "Lab",
  loading: false,
  control: { owner: "agent", ownedByCaller: true, generation: 1 },
} satisfies PreviewAutomationStatus;
const steps: PreviewBatchStep[] = [
  { operation: "type", locator: "#title", text: "New", clear: true },
  { operation: "click", locator: "button.save" },
  { operation: "waitFor", text: "Saved" },
];
const input = { tabId, expectedOrigin: origin, steps };
describe("bounded browser batches", () => {
  it("does not substitute an exact patch on an older browser client", async () => {
    const attempted: string[] = [];
    const patch = {
      ...input,
      steps: [
        {
          operation: "patchText" as const,
          locator: "textarea",
          edits: [{ kind: "replace" as const, old: "old", text: "new", count: 1 }],
        },
        { operation: "click" as const, locator: "button.save" },
      ],
    };
    const result = await Effect.runPromise(
      executePreviewBatch(patch, {
        status: Effect.succeed(status),
        snapshot: Effect.succeed(state),
        action: (step) =>
          Effect.suspend(() => {
            attempted.push(step.operation);
            return Effect.fail({ _tag: "PreviewAutomationUnsupportedClientError" });
          }),
      }),
    );
    expect(attempted).toEqual(["patchText"]);
    expect(result).toMatchObject({
      status: "incomplete",
      deliveryUnknown: false,
      readBeforeRetry: true,
      taskSuccessVerified: false,
    });
  });

  it("passes an exact patch through the ordinary caller-bound action path", async () => {
    const patch = {
      ...input,
      steps: [
        {
          operation: "patchText" as const,
          locator: "textarea",
          edits: [{ kind: "replace" as const, old: "old", text: "new", count: 1 }],
        },
      ],
    };
    const received: PreviewBatchStep[] = [];
    const result = await Effect.runPromise(
      executePreviewBatch(patch, {
        status: Effect.succeed(status),
        snapshot: Effect.succeed(state),
        action: (step) =>
          Effect.sync(() => {
            received.push(step);
          }),
      }),
    );
    expect(received).toEqual(patch.steps);
    expect(result).toMatchObject({ status: "actions_completed", taskSuccessVerified: false });
  });

  it("uses ordered ordinary actions and returns fresh state without claiming task success", async () => {
    const calls: string[] = [];
    let reads = 0;
    const result = await Effect.runPromise(
      executePreviewBatch(input, {
        status: Effect.sync(() => {
          reads++;
          return status;
        }),
        snapshot: Effect.succeed(state),
        action: (step) =>
          Effect.sync(() => {
            calls.push(step.operation);
          }),
      }),
    );
    expect(calls).toEqual(["type", "click", "waitFor"]);
    expect(reads).toBe(3);
    expect(result.status).toBe("actions_completed");
    expect(result.taskSuccessVerified).toBe(false);
    expect(result.state).toBe(state);
  });
  it("stops after an uncertain mutation without replay or later actions", async () => {
    const calls: string[] = [];
    const result = await Effect.runPromise(
      executePreviewBatch(input, {
        status: Effect.succeed(status),
        snapshot: Effect.succeed(state),
        action: (step) =>
          Effect.suspend(() => {
            calls.push(step.operation);
            return step.operation === "click" ? Effect.fail("unknown delivery") : Effect.void;
          }),
      }),
    );
    expect(calls).toEqual(["type", "click"]);
    expect(result).toMatchObject({
      status: "incomplete",
      stoppedAt: 1,
      deliveryUnknown: true,
      readBeforeRetry: true,
      taskSuccessVerified: false,
    });
  });
  it.each(["human", "foreign", "dialog"])("checks %s before the next mutation", async (kind) => {
    let reads = 0,
      actions = 0;
    const altered =
      kind === "human"
        ? { ...status, control: { owner: "human" as const, ownedByCaller: false, generation: 2 } }
        : kind === "foreign"
          ? { ...status, url: "https://other.invalid/" }
          : { ...status, dialog: { type: "confirm", message: "unexpected", defaultValue: "" } };
    const result = await Effect.runPromise(
      executePreviewBatch(input, {
        status: Effect.sync(() => (++reads === 1 ? status : altered)),
        snapshot: Effect.succeed(state),
        action: () =>
          Effect.sync(() => {
            actions++;
          }),
      }),
    );
    expect(actions).toBe(1);
    expect(result).toMatchObject({ status: "incomplete", stoppedAt: 1, deliveryUnknown: false });
  });
  it("does not turn a missing final observation into completed work", async () => {
    const result = await Effect.runPromise(
      executePreviewBatch(input, {
        status: Effect.succeed(status),
        snapshot: Effect.fail("read failed"),
        action: () => Effect.void,
      }),
    );
    expect(result).toMatchObject({
      status: "incomplete",
      stoppedAt: 3,
      state: null,
      taskSuccessVerified: false,
    });
  });
  it("rejects unsupported actions, non-origin URLs and oversized batches before execution", () => {
    const decode = Schema.decodeUnknownSync(PreviewBatchInput);
    expect(() => decode({ ...input, steps: Array(9).fill(steps[0]) })).toThrow();
    expect(() =>
      decode({
        ...input,
        steps: [{ operation: "evaluate", expression: "fetch('https://other.invalid')" }],
      }),
    ).toThrow();
    expect(() => decode({ ...input, expectedOrigin: origin + "/edit" })).toThrow();
  });
  it("preserves cancellation and never starts a subsequent action", async () => {
    let actions = 0;
    const result = await Effect.runPromiseExit(
      executePreviewBatch(input, {
        status: Effect.succeed(status),
        snapshot: Effect.succeed(state),
        action: () =>
          Effect.suspend(() => {
            actions++;
            return Effect.interrupt;
          }),
      }),
    );
    expect(result._tag).toBe("Failure");
    expect(actions).toBe(1);
  });
});

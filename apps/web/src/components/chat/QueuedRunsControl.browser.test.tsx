import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  workflow: null as unknown,
  mutations: [] as unknown[],
}));

vi.mock(import("@t3tools/client-runtime/state/thread-workflows"), async (importOriginal) => ({
  ...(await importOriginal()),
  deriveThreadQueueWorkflowState: (() => state.workflow) as never,
}));

vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useThreadProjection: (() => state.projection) as never,
}));

vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: (() => async (input: unknown) => {
    state.mutations.push(input);
  }) as never,
}));

vi.mock(import("../../assets/assetUrls"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAssetUrls: ((_environmentId: never, resources: ReadonlyArray<{ attachmentId: string }>) =>
    resources.map((resource) => `https://assets.test/${resource.attachmentId}`)) as never,
}));

import { QueuedRunsControl } from "./QueuedRunsControl";

const roots: Root[] = [];

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

async function render(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<QueuedRunsControl {...baseProps} {...props} />));
  return container;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

it("edits, reorders and removes the focused queued message instead of its neighbours", async () => {
  state.mutations = [];
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: ["first", "second", "third"].map((id) => ({
      run: { id: `run:${id}`, userMessageId: `message:${id}` },
      text: id,
      attachments: [],
    })),
  };
  const edit = vi.fn();
  const view = await render({ onEditQueuedRun: edit });
  const middle = [
    ...view.querySelectorAll<HTMLElement>('[data-keyboard-object="Queued message"]'),
  ][1]!;
  await act(async () => {
    middle.focus();
    middle.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowUp",
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  expect(state.mutations).toEqual([
    {
      environmentId: baseProps.environmentId,
      input: { threadId: baseProps.threadId, runId: "run:second", beforeRunId: "run:first" },
    },
  ]);
  await act(async () => {
    middle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "e", bubbles: true, cancelable: true }),
    );
  });
  expect(edit).toHaveBeenCalledWith(
    expect.objectContaining({ runId: "run:second", text: "second" }),
  );
  await act(async () => {
    middle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
    );
  });
  expect(state.mutations.at(-1)).toEqual({
    environmentId: baseProps.environmentId,
    input: { threadId: baseProps.threadId, runId: "run:second" },
  });
});

describe("QueuedRunsControl automatic completion delivery", () => {
  it("does not render a queue control when only hidden delivery remains", async () => {
    state.projection = {
      projection: {
        messages: [
          {
            delegatedCompletion: {
              parentRunId: "run:parent",
              generation: 1,
              taskIds: ["task:child"],
            },
            id: "message:completion",
          },
        ],
      },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render();

    expect(view.childElementCount).toBe(0);
  });
});

describe("QueuedRunsControl attachments and edit mode", () => {
  const workflowWithAttachment = () => ({
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:queued", userMessageId: "message:queued" },
        text: "Queued with a screenshot",
        attachments: [
          {
            type: "image",
            id: "attachment-1",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 128,
          },
        ],
      },
    ],
  });

  it("renders an attachment thumbnail on the queued row", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render();

    expect(view.querySelector("img")?.getAttribute("src")).toBe("https://assets.test/attachment-1");
    expect(view.textContent).toContain("Queued with a screenshot");
    expect(labels(view)).toContain("Edit queued message");
    expect(labels(view)).toContain("Reorder queued message (drag, or press the arrow keys)");
    expect(labels(view)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    const view = await render({
      optimisticMessages: [
        {
          id: "message:acknowledged" as never,
          inputIntent: "queued_turn",
          text: "hello",
          attachments: [],
        },
      ],
    });

    expect(view.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    const view = await render({ editingRunId: "run:queued" as never });

    expect(view.textContent).toContain("Queued with a screenshot");
  });
});

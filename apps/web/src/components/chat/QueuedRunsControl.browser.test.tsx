import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

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

import { act, render } from "../../../test/render";
import { QueuedRunsControl } from "./QueuedRunsControl";

function setup() {
  state.projection = null;
  state.workflow = null;
  state.mutations = [];
}

const baseProps = {
  environmentId: "environment:test" as never,
  optimisticMessages: [],
  threadId: "thread:test" as never,
  editingRunId: null,
  onEditQueuedRun: () => undefined,
  onCancelEdit: () => undefined,
} satisfies ComponentProps<typeof QueuedRunsControl>;

function queue(props: Partial<ComponentProps<typeof QueuedRunsControl>> = {}) {
  return <QueuedRunsControl {...baseProps} {...props} />;
}

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("[aria-label]")].map((element) =>
    element.getAttribute("aria-label"),
  );

it("edits, reorders and removes the focused queued message instead of its neighbours", async () => {
  setup();
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
  await using screen = await render(queue({ onEditQueuedRun: edit }));
  const view = screen.container;
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
    setup();
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

    await using screen = await render(queue());
    const view = screen.container;

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
    setup();
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    await using screen = await render(queue());
    const view = screen.container;

    expect(view.querySelector("img")?.getAttribute("src")).toBe("https://assets.test/attachment-1");
    expect(view.textContent).toContain("Queued with a screenshot");
    expect(labels(view)).toContain("Edit queued message");
    expect(labels(view)).toContain("Reorder queued message (drag, or press the arrow keys)");
    expect(labels(view)).not.toContain("Move queued message up");
  });

  it("drops the optimistic pending row once the projection holds its message", async () => {
    setup();
    state.projection = {
      projection: { messages: [{ id: "message:acknowledged", text: "hello" }] },
    };
    state.workflow = {
      activeRun: { id: "run:active" },
      canPromoteToSteer: true,
      canReorder: true,
      queuedRuns: [],
    };

    await using screen = await render(
      queue({
        optimisticMessages: [
          {
            id: "message:acknowledged" as never,
            inputIntent: "queued_turn",
            text: "hello",
            attachments: [],
          },
        ],
      }),
    );
    const view = screen.container;

    expect(view.childElementCount).toBe(0);
  });

  it("keeps the original queued message visible while editing", async () => {
    setup();
    state.projection = { projection: { messages: [] } };
    state.workflow = workflowWithAttachment();

    await using screen = await render(queue({ editingRunId: "run:queued" as never }));
    const view = screen.container;

    expect(view.textContent).toContain("Queued with a screenshot");
  });
});

it("previews assistant quotes as readable text and preserves the citation when editing", async () => {
  setup();
  const quotedText = "Cache the parsed config per worktree.";
  const quote = serializeAssistantCitation({
    version: 1,
    environmentId: EnvironmentId.make("environment:test"),
    threadId: ThreadId.make("thread:test"),
    messageId: MessageId.make("message:assistant"),
    text: quotedText,
    start: 0,
    end: quotedText.length,
    prefix: "",
    suffix: "",
  });
  const quoteAndText = `${quote}\n\nWhy per worktree?`;
  state.projection = { projection: { messages: [] } };
  state.workflow = {
    activeRun: { id: "run:active" },
    canPromoteToSteer: true,
    canReorder: true,
    queuedRuns: [
      {
        run: { id: "run:quote-only", userMessageId: "message:quote-only" },
        text: quote,
        attachments: [],
      },
      {
        run: { id: "run:quote-and-text", userMessageId: "message:quote-and-text" },
        text: quoteAndText,
        attachments: [],
      },
    ],
  };
  const onEditQueuedRun = vi.fn();
  await using _screen = await render(queue({ onEditQueuedRun }));

  await expect.element(page.getByText(quotedText, { exact: true })).toBeVisible();
  await expect
    .element(page.getByText(`${quotedText} Why per worktree?`, { exact: true }))
    .toBeVisible();

  await page.getByRole("button", { name: "Edit queued message", exact: true }).nth(1).click();
  expect(onEditQueuedRun).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ text: quoteAndText }),
  );
});

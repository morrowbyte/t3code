// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";
import { AttentionInboxView } from "./AttentionInboxView";
import { deriveAttentionInbox } from "./attentionInbox.logic";

const now = DateTime.makeUnsafe("2026-10-17T09:30:00.000Z");
const environmentId = EnvironmentId.make("luna");
const base = makeThreadFixture().source;
function question(id: string): OrchestrationV2ThreadShell {
  return {
    ...base,
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    status: "waiting",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make(`request-${id}`),
      kind: "user_input",
      createdAt: now,
    },
  };
}

describe("attention inbox user workflow", () => {
  it("filters canonical items, opens the exact source, and reflects answers and reconnects without local dismissal", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const open = vi.fn();
    const pending = question("question");
    const completed = {
      ...question("result"),
      status: "completed" as const,
      activeRunId: null,
      pendingRuntimeRequest: null,
      latestRunId: RunId.make("completed-run"),
      latestRunCompletedAt: now,
      settledOverride: null,
    };
    const view = (threads: OrchestrationV2ThreadShell[], status: "live" | "cached" = "live") => (
      <AttentionInboxView
        model={deriveAttentionInbox(environmentId, threads)}
        environmentLabel="Luna"
        status={status}
        hasSnapshot
        synchronizationError={null}
        navigationError={null}
        onOpenThread={open}
      />
    );
    const button = (text: string) =>
      [...container.querySelectorAll("button")].find((element) =>
        element.textContent?.startsWith(text),
      )!;
    try {
      await act(async () => root.render(view([pending, completed])));
      expect(container.querySelectorAll('ul[aria-label="Attention items"] > li')).toHaveLength(2);
      await act(async () => button("Questions").click());
      expect(container.querySelectorAll('ul[aria-label="Attention items"] > li')).toHaveLength(1);
      await act(async () => button("Open thread").click());
      expect(open).toHaveBeenCalledWith({ environmentId, threadId: pending.id });
      expect(container.textContent).toContain("Questions (1)");
      expect(container.querySelector('[aria-label="Attention in Luna"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Live environment data");
      expect(container.textContent).not.toContain("Other environments are not included");

      await act(async () =>
        root.render(view([{ ...pending, pendingRuntimeRequest: null }, completed])),
      );
      expect(container.textContent).toContain("Questions (0)");
      expect(container.querySelector('ul[aria-label="Attention items"]')).toBeNull();
      expect(container.textContent).toContain("No matching attention items in the loaded threads");
      await act(async () => button("Completed work").click());
      expect(container.textContent).toContain("Thread result");
      await act(async () =>
        root.render(view([{ ...completed, settledOverride: "settled" }], "cached")),
      );
      expect(container.textContent).toContain("Current attention is not verified");
      expect(container.textContent).toContain("out of date");
      await act(async () => root.render(view([pending, completed])));
      await act(async () => button("Questions").click());
      expect(container.textContent).toContain("Questions (1)");
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("bounds initial rendering and keeps later canonical items reachable", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    const root = createRoot(container);
    const threads = Array.from({ length: 51 }, (_, index) => question(`question-${index}`));
    try {
      await act(async () =>
        root.render(
          <AttentionInboxView
            model={deriveAttentionInbox(environmentId, threads)}
            environmentLabel="Luna"
            status="live"
            hasSnapshot
            synchronizationError={null}
            navigationError={null}
            onOpenThread={vi.fn()}
          />,
        ),
      );
      expect(container.querySelectorAll('ul[aria-label="Attention items"] > li')).toHaveLength(50);
      expect(container.textContent).toContain("Showing 50 of 51");
      const more = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Show more",
      )!;
      await act(async () => more.click());
      expect(container.querySelectorAll('ul[aria-label="Attention items"] > li')).toHaveLength(51);
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
    }
  });
});

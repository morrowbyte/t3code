import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

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
    await using screen = await render(view([pending, completed]));
    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('ul[aria-label="Attention items"] > li'),
      ).toHaveLength(1),
    );
    await expect
      .element(screen.getByRole("button", { name: "All (1)", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText("Completed work", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread result", { exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Questions (1)", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('ul[aria-label="Attention items"] > li'),
      ).toHaveLength(1),
    );
    await screen
      .getByRole("button", { name: `Open source conversation: ${pending.title}` })
      .click();
    expect(open).toHaveBeenCalledWith({ environmentId, threadId: pending.id });
    await expect
      .element(screen.getByRole("button", { name: "Questions (1)", exact: true }))
      .toBeVisible();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[aria-label="Attention in Luna"]')).not.toBeNull(),
    );
    await expect
      .element(screen.getByText("Live environment data", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Other environments are not included"))
      .not.toBeInTheDocument();

    await screen.rerender(view([{ ...pending, pendingRuntimeRequest: null }, completed]));
    await expect
      .element(screen.getByRole("button", { name: "Questions (0)", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("list", { name: "Attention items" }))
      .not.toBeInTheDocument();
    await expect
      .element(
        screen.getByText("No matching attention items in the loaded threads.", { exact: true }),
      )
      .toBeVisible();
    await screen.getByRole("button", { name: "All (0)", exact: true }).click();
    await expect
      .element(screen.getByText("Completed work", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Thread result", { exact: true }))
      .not.toBeInTheDocument();
    await screen.rerender(view([{ ...completed, settledOverride: "settled" }], "cached"));
    await expect
      .element(
        screen.getByText(
          "No matching items in the cached data. Current attention is not verified.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Cached environment data; shown items may be out of date.", {
          exact: true,
        }),
      )
      .toBeVisible();
    await screen.rerender(view([pending, completed]));
    await screen.getByRole("button", { name: "Questions (1)", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Questions (1)", exact: true }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("bounds initial rendering and keeps later canonical items reachable", async () => {
    const threads = Array.from({ length: 51 }, (_, index) => question(`question-${index}`));
    await using screen = await render(
      <AttentionInboxView
        model={deriveAttentionInbox(environmentId, threads)}
        environmentLabel="Luna"
        status="live"
        hasSnapshot
        synchronizationError={null}
        navigationError={null}
        onOpenThread={vi.fn()}
      />,
    );
    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('ul[aria-label="Attention items"] > li'),
      ).toHaveLength(50),
    );
    await expect
      .element(screen.getByText("Showing 50 of 51 matching items.", { exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Show more", exact: true }).click();
    await vi.waitFor(() =>
      expect(
        screen.container.querySelectorAll('ul[aria-label="Attention items"] > li'),
      ).toHaveLength(51),
    );
  });
});

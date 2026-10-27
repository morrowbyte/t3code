import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { BackgroundWorkActivity } from "./BackgroundWorkActivity";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { TurnItemId } from "@t3tools/contracts";
import { getSyntaxHighlighterPromise } from "../../lib/syntaxHighlighting";

const command =
  "/bin/bash -lc 'umask 077; PATH=/bin vp run dev --port 14664 > /tmp/private.log 2>&1'";

describe("background process activity", () => {
  it("shows semantic activity and readable highlighted Python while retaining the full shell command", async () => {
    const source = "import json\nprint(json.dumps({'status': True}))\n";
    const original = `/run/current-system/sw/bin/bash -lc "python3 - <<'PY'\n${source}PY"`;
    const title = "Inspect recording permission preferences";
    const presentation = presentPendingBackgroundWork(
      [{ taskId: "python", kind: "command", description: original }],
      [
        {
          id: TurnItemId.make("python"),
          type: "command_execution",
          nativeItemRef: null,
          input: original,
          title,
          status: "running",
        },
      ],
    )!;
    await using screen = await render(
      <BackgroundWorkActivity
        presentation={presentation}
        canStop
        stopping={false}
        onStopThread={vi.fn()}
        onOpenThread={vi.fn()}
      />,
    );
    await screen.getByRole("button", { name: `Show details for ${title}` }).click();
    await getSyntaxHighlighterPromise("python");
    const script = screen.container.querySelector('[aria-label="Embedded script"]');
    expect(script?.textContent).toBe(source);
    await vi.waitFor(() => {
      const colors = new Set(
        [...script!.querySelectorAll<HTMLElement>("[style]")].map((token) => token.style.color),
      );
      expect(colors.size).toBeGreaterThan(1);
    });
    expect(screen.container.querySelector('[aria-label="Full command"]')?.textContent).toBe(
      original,
    );
    expect(screen.container.querySelector("details")?.open).toBe(false);
    await screen.getByText("Full command", { exact: true }).click();
    expect(screen.container.querySelector("details")?.open).toBe(true);
  });

  it("opens the original command with keyboard and keeps thread stop separate", async () => {
    const onStop = vi.fn();
    const presentation = presentPendingBackgroundWork([
      { taskId: "dev", kind: "command", description: command },
    ])!;
    await using screen = await render(
      <ComposerBannerStack
        items={[
          {
            id: "background-work:test",
            variant: "default",
            priority: "activity",
            title: presentation.title,
            icon: null,
            content: (
              <BackgroundWorkActivity
                presentation={presentation}
                canStop
                stopping={false}
                onStopThread={onStop}
                onOpenThread={vi.fn()}
              />
            ),
          },
        ]}
      />,
    );
    const disclosure = screen.getByRole("button", { name: "Show details for vp run dev" });
    expect(screen.container.textContent).not.toContain("PATH=/bin");
    await disclosure.click();
    expect(screen.container.querySelector('[aria-label="Full command"]')?.textContent).toBe(
      command,
    );
    expect(onStop).not.toHaveBeenCalled();
    await userEvent.keyboard("{Enter}");
    expect(screen.container.querySelector('[aria-label="Full command"]')).toBeNull();
    await screen.getByRole("button", { name: "Stop all work in this thread" }).click();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("shows several command identities and one shared thread stop, including pending stop", async () => {
    const onStop = vi.fn();
    const presentation = presentPendingBackgroundWork([
      { taskId: "dev", kind: "command", description: command },
      { taskId: "unknown", kind: "command", description: "while true; do sleep 1; done" },
    ])!;
    await using screen = await render(
      <BackgroundWorkActivity
        presentation={presentation}
        canStop
        stopping={false}
        onStopThread={onStop}
        onOpenThread={vi.fn()}
      />,
    );
    expect(screen.container.textContent).toContain("vp run dev");
    expect(screen.container.textContent).toContain("Command");
    expect(
      screen.container.querySelectorAll('button[aria-label="Stop all work in this thread"]'),
    ).toHaveLength(1);
    await screen.getByRole("button", { name: "Show details for Command", exact: true }).click();
    expect(screen.container.querySelector('[aria-label="Full command"]')?.textContent).toBe(
      "while true; do sleep 1; done",
    );
    await screen.rerender(
      <BackgroundWorkActivity
        presentation={presentation}
        canStop
        stopping
        onStopThread={onStop}
        onOpenThread={vi.fn()}
      />,
    );
    expect(
      screen.container.querySelector<HTMLButtonElement>(
        'button[aria-label="Stop all work in this thread"]',
      )?.disabled,
    ).toBe(true);
    expect(screen.container.textContent).toContain("Stopping thread…");
    expect(screen.container.textContent).not.toContain("Ready");
  });
});

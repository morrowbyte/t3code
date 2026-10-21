import { act, render } from "../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import type { LiveVoiceState } from "@t3tools/client-runtime/live-voice";

const clipboard = vi.hoisted(() => ({ writeTextToClipboard: vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: clipboard.writeTextToClipboard,
}));

import { LiveVoiceTranscript } from "./LiveVoiceTranscript";

const transcript: LiveVoiceState["transcript"] = [
  { speaker: "user", text: "First question", final: true },
  { speaker: "assistant", text: "First answer", final: true },
  { speaker: "user", text: `Second question ${"full text ".repeat(70)}`, final: true },
];

function setup() {
  clipboard.writeTextToClipboard.mockReset().mockResolvedValue(true);
}

function button(label: string): HTMLButtonElement {
  const element = [...document.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.trim() === label || candidate.getAttribute("aria-label") === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}

async function click(label: string) {
  await act(async () => button(label).click());
}

async function pressEnter(target: HTMLButtonElement) {
  await act(() => target.focus());
  await userEvent.keyboard("{Enter}");
}

describe("LiveVoiceTranscript", () => {
  it("opens the retained conversation, copies every full turn, and restores trigger focus on Escape", async () => {
    setup();
    await using screen = await render(<LiveVoiceTranscript transcript={transcript} />, {
      router: false,
    });
    const trigger = button("Transcript");
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();

    await pressEnter(trigger);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const list = dialog!.querySelector<HTMLOListElement>("ol");
    expect(list?.querySelectorAll("li")).toHaveLength(3);
    expect(list?.textContent).toContain("YouFirst question");
    expect(list?.textContent).toContain("LiveFirst answer");
    expect(list?.textContent).toContain(transcript[2]?.text);
    expect(list?.textContent?.length).toBeGreaterThan(500);
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();

    const expectedCopy = transcript
      .map((entry) => `${entry.speaker === "user" ? "You" : "Live"}:\n${entry.text}`)
      .join("\n\n");
    await click("Copy transcript");
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledWith(expectedCopy, "Live transcript");
    expect(dialog?.textContent).toContain("Transcript copied.");

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    await expect.poll(() => document.activeElement).toBe(trigger);
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledOnce();
  });

  it("reports a copy failure truthfully and lets the user retry", async () => {
    setup();
    clipboard.writeTextToClipboard.mockRejectedValueOnce(new Error("clipboard unavailable"));
    await using screen = await render(<LiveVoiceTranscript transcript={transcript} />, {
      router: false,
    });
    await click("Transcript");
    await click("Copy transcript");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn’t copy transcript. Try again.",
    );
    expect(document.querySelector('[role="status"]')).toBeNull();

    await click("Copy transcript");
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Transcript copied.");
    expect(clipboard.writeTextToClipboard).toHaveBeenCalledTimes(2);
  });

  it("closes and clears when the current session transcript resets", async () => {
    setup();
    await using screen = await render(<LiveVoiceTranscript transcript={transcript} />, {
      router: false,
    });
    await click("Transcript");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await screen.rerender(<LiveVoiceTranscript transcript={[]} />);
    await expect.poll(() => document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector("button")).toBeNull();
    expect(clipboard.writeTextToClipboard).not.toHaveBeenCalled();
  });
});

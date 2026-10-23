import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { VoiceConversationRow } from "./VoiceConversationRow";

const clipboard = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: clipboard.write, isCopied: false }),
}));

it("keeps received speech readable and copies exactly one utterance including whitespace", async () => {
  clipboard.write.mockReset();
  const text = "  Actual received speech\nwith original whitespace.  ";
  await using screen = await render(
    <VoiceConversationRow
      item={{
        id: "voice:call:1:speech:one",
        callKey: "call:1",
        kind: "speech",
        createdAt: "2026-10-23T18:00:00.000Z",
        entry: {
          id: "one",
          speaker: "assistant",
          text,
          final: true,
          occurredAt: "2026-10-23T18:00:00.000Z",
          updatedAt: "2026-10-23T18:00:00.000Z",
        },
      }}
    />,
  );
  await expect.element(screen.getByRole("article", { name: "Live · Voice" })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Copy message" }));
  expect(clipboard.write).toHaveBeenCalledExactlyOnceWith(text);
  expect(screen.container.querySelector("dialog")).toBeNull();
});

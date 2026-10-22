import { useState } from "react";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { useChatShortcuts } from "./useChatShortcuts";

function ShortcutFixture({
  owner,
  onChatFind,
  onCloseThreadFind,
  onAppCommand,
}: {
  owner?: "dialog" | "editor" | "local";
  onChatFind: () => void;
  onCloseThreadFind: () => void;
  onAppCommand: () => void;
}) {
  const [search, setSearch] = useState(false);
  const [page, setPage] = useState(0);
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
      modelPickerOpen: false,
    }),
    threadFindActive: true,
    typeIntoComposer: () => false,
    closeThreadFind: onCloseThreadFind,
    commands: { "chat.find": onChatFind, "diff.toggle": onAppCommand },
    fallback: () => onAppCommand,
  });
  return (
    <div
      role={owner === "dialog" ? "dialog" : undefined}
      // oxlint-disable-next-line shadcn/no-unknown-classes -- CodeMirror supplies this keyboard-owner class.
      className={owner === "editor" ? "cm-editor" : undefined}
      data-keyboard-local={owner === "local" ? "true" : undefined}
      onKeyDown={(event) => {
        if (!owner) return;
        if (event.ctrlKey && event.key === "f") {
          event.preventDefault();
          setSearch(true);
        } else if (event.ctrlKey && event.key === "d") {
          event.preventDefault();
          setPage((value) => value + 1);
        } else if (event.key === "Escape") {
          setSearch(false);
        }
      }}
    >
      <textarea aria-label="Review source" />
      {search && <input aria-label="Find in source" />}
      <output aria-label="Source page">{page}</output>
    </div>
  );
}

it.each(["dialog", "editor", "local"] as const)(
  "keeps search, paging, and Escape with the %s keyboard owner",
  async (owner) => {
    const onChatFind = vi.fn();
    const onCloseThreadFind = vi.fn();
    const onAppCommand = vi.fn();
    await using screen = await render(
      <ShortcutFixture
        owner={owner}
        onChatFind={onChatFind}
        onCloseThreadFind={onCloseThreadFind}
        onAppCommand={onAppCommand}
      />,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "Review source" }));
    await userEvent.keyboard("{Control>}f{/Control}");
    await expect.element(screen.getByRole("textbox", { name: "Find in source" })).toBeVisible();
    await userEvent.keyboard("{Control>}d{/Control}");
    await expect.element(screen.getByLabelText("Source page")).toHaveTextContent("1");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(screen.getByRole("textbox", { name: "Find in source" }))
      .not.toBeInTheDocument();
    expect(onChatFind).not.toHaveBeenCalled();
    expect(onAppCommand).not.toHaveBeenCalled();
    expect(onCloseThreadFind).not.toHaveBeenCalled();
  },
);

it("still opens thread find and dismisses it from the ordinary composer", async () => {
  const onChatFind = vi.fn();
  const onCloseThreadFind = vi.fn();
  await using screen = await render(
    <ShortcutFixture
      onChatFind={onChatFind}
      onCloseThreadFind={onCloseThreadFind}
      onAppCommand={() => {}}
    />,
  );
  await userEvent.click(screen.getByRole("textbox", { name: "Review source" }));
  await userEvent.keyboard("{Control>}f{/Control}");
  expect(onChatFind).toHaveBeenCalledOnce();
  await userEvent.keyboard("{Escape}");
  expect(onCloseThreadFind).toHaveBeenCalledOnce();
});

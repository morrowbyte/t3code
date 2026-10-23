import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useEffect, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { useChatShortcuts } from "./useChatShortcuts";

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

const focusOnMount = (element: HTMLElement | null) => element?.focus();

// Stands in for the right panel's launcher, which needs the whole app around it. Like the
// real one it takes focus, advertises its letters in `data-surface-launcher-keys`, and
// claims one from its own window capture listener unless the key was already handled.
function Launcher(props: { keys: string; received: string[] }) {
  useEffect(() => {
    const claim = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (!props.keys.toLowerCase().split("").includes(event.key.toLowerCase())) return;
      event.preventDefault();
      props.received.push(event.key);
    };
    window.addEventListener("keydown", claim, true);
    return () => window.removeEventListener("keydown", claim, true);
  }, [props.keys, props.received]);
  return (
    <div
      ref={focusOnMount}
      tabIndex={0}
      aria-label="Open a surface"
      data-surface-launcher-keys={props.keys}
    />
  );
}

// The chat's shortcut listener registers when the chat mounts, so a launcher that opens
// later registers after it. Tests mount the chat first and add the launcher by rerendering.
function Chat(props: { composerKeys: string[]; launcher?: { keys: string; received: string[] } }) {
  useChatShortcuts({
    enabled: true,
    keybindings: [],
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    // Type-to-focus only calls insertTextAtEnd, so the stand-in composer implements just that.
    composerRef: {
      current: {
        insertTextAtEnd: (key: string) => {
          props.composerKeys.push(key);
          return true;
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return props.launcher ? <Launcher {...props.launcher} /> : null;
}

// router: false because the chat shortcuts and the launcher stand-in never navigate.
const options = { router: false } as const;

it("leaves the launcher's letters to the launcher, in either case", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("tT");

  expect(received).toEqual(["t", "T"]);
  expect(composerKeys).toEqual([]);
});

it("still types other letters into the composer while the launcher is open", async () => {
  const composerKeys: string[] = [];
  const received: string[] = [];
  await using screen = await render(<Chat composerKeys={composerKeys} />, options);
  await screen.rerender(<Chat composerKeys={composerKeys} launcher={{ keys: "BT", received }} />);

  await userEvent.keyboard("a");

  expect(composerKeys).toEqual(["a"]);
  expect(received).toEqual([]);
});

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
    composerRef: { current: null },
    branchToolbarRef: { current: null },
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

import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";
import type { KeybindingCommand } from "@t3tools/contracts";
import { openCommandPalette } from "../../commandPaletteBus";
import { isContextMenuOpen } from "../../contextMenuFallback";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isPreviewFocused } from "../../lib/previewFocus";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useSidebar } from "../ui/sidebar";
import { LeaderNavigation, type LeaderNavigationGroup } from "./LeaderNavigation";
import { activateAdjacentThread, clickVisible, focusElement } from "./LeaderNavigation.dom";
import { dispatchKeyboardCommand } from "./keyboardCommands";
import { KeyboardHints } from "./KeyboardHints";
import { toastManager } from "../ui/toast";

export function LeaderNavigationHost() {
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action === "navigation.activate") dispatchKeyboardCommand("navigation.activate");
      }),
    [],
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const sidebar = useSidebar();
  const showSidebar = () => {
    if (sidebar.isMobile) sidebar.setOpenMobile(true);
    else sidebar.setOpen(true);
  };
  const leaveSidebar = async () => {
    if (!sidebar.isMobile || !sidebar.openMobile) return;
    const sheet = document.querySelector<HTMLElement>(
      '[data-sidebar="sidebar"][data-mobile="true"]',
    );
    sidebar.setOpenMobile(false);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await Promise.allSettled((sheet?.getAnimations() ?? []).map((animation) => animation.finished));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  };
  const command = (key: string, label: string, id: KeybindingCommand) => ({
    key,
    label,
    shortcut: shortcutLabelForCommand(keybindings, id),
    run: async () => {
      if (!dispatchKeyboardCommand(id))
        toastManager.add({
          type: "info",
          title: `${label} is unavailable in this thread`,
        });
    },
  });
  const groups: LeaderNavigationGroup[] = [
    {
      key: "c",
      label: "Composer",
      actions: [
        command("m", "Model", "modelPicker.toggle"),
        command("r", "Reasoning", "composer.effort"),
        command("s", "Service tier", "composer.serviceTier"),
        command("a", "Access", "composer.access"),
      ],
    },
    {
      key: "v",
      label: "Voice",
      actions: [
        command("d", "Dictation", "voice.dictation"),
        command("c", "Call", "voice.call"),
        command("m", "Mute microphone", "voice.mute"),
      ],
    },
    {
      key: "f",
      label: "Files",
      actions: [
        command("a", "Attach files", "composer.attachFiles"),
        command("f", "Find workspace file", "filePicker.toggle"),
        command("s", "Search project contents", "projectSearch.toggle"),
      ],
    },
    {
      key: "r",
      label: "Right panel",
      actions: [
        command("f", "Files", "rightPanel.files"),
        command("d", "Diff", "rightPanel.diff"),
        command("b", "Browser", "rightPanel.browser"),
        command("t", "Terminal", "rightPanel.terminal"),
        command("p", "Pull requests", "rightPanel.pullRequests"),
        command("v", "Device", "rightPanel.device"),
        command("e", "Execution code", "rightPanel.execution"),
        command("r", "Toggle panel", "rightPanel.toggle"),
        command("m", "Maximize panel", "rightPanel.toggleMaximized"),
        command("x", "Close current tab", "rightPanel.close"),
        command("o", "Reopen closed tab", "view.reopenClosed"),
      ],
    },
    {
      key: "w",
      label: "Workspace",
      actions: [
        command("w", "Toggle workspace card", "threadPanel.toggle"),
        command("s", "Run project script", "project.scripts"),
        command("g", "Git and workspace actions", "workspace.actions"),
      ],
    },
    {
      key: "t",
      label: "Threads",
      actions: [
        {
          key: "n",
          label: "Next thread",
          shortcut: shortcutLabelForCommand(keybindings, "thread.next"),
          run: async () => {
            showSidebar();
            requestAnimationFrame(() => activateAdjacentThread(1));
          },
        },
        {
          key: "p",
          label: "Previous thread",
          shortcut: shortcutLabelForCommand(keybindings, "thread.previous"),
          run: async () => {
            showSidebar();
            requestAnimationFrame(() => activateAdjacentThread(-1));
          },
        },
        {
          key: "f",
          label: "Find thread",
          shortcut: shortcutLabelForCommand(keybindings, "commandPalette.toggle"),
          run: async () => {
            openCommandPalette();
          },
        },
      ],
    },
    {
      key: "p",
      label: "Projects",
      actions: [
        {
          key: "f",
          label: "Filter by project",
          run: async () => {
            showSidebar();
            requestAnimationFrame(() => {
              clickVisible('[aria-label^="Filter threads by project"]');
            });
          },
        },
        {
          key: "a",
          label: "Add project",
          run: async () => {
            openCommandPalette({ open: "add-project" });
          },
        },
      ],
    },
    {
      key: "s",
      label: "Sidebar",
      actions: [
        {
          key: "t",
          label: "Toggle sidebar",
          shortcut: shortcutLabelForCommand(keybindings, "sidebar.toggle"),
          run: async () => {
            sidebar.toggleSidebar();
          },
        },
        {
          key: "s",
          label: "Search threads",
          run: async () => {
            showSidebar();
            requestAnimationFrame(() => {
              focusElement(
                document.querySelector<HTMLInputElement>('[aria-label="Search threads"]'),
              );
            });
          },
        },
      ],
    },
    {
      key: "a",
      label: "Actions",
      actions: [
        command("c", "Context controls", "navigation.contextActions"),
        command("h", "Keyboard hints", "navigation.hints"),
        {
          key: "p",
          label: "Command palette",
          run: async () => {
            openCommandPalette({ query: ">" });
          },
        },
        {
          key: "t",
          label: "Thread actions",
          run: async () => {
            if (!clickVisible('button[aria-label^="Thread actions for"]'))
              openCommandPalette({ query: ">" });
          },
        },
      ],
    },
  ];
  return (
    <>
      <KeyboardHints />
      <LeaderNavigation
        groups={groups}
        showSidebar={showSidebar}
        leaveSidebar={leaveSidebar}
        isClaimed={(event) =>
          isContextMenuOpen() ||
          isTerminalFocused() ||
          isPreviewFocused() ||
          resolveShortcutCommand(event, keybindings) !== null
        }
        isActivationShortcut={(event) =>
          resolveShortcutCommand(event, keybindings) === "navigation.activate"
        }
      />
    </>
  );
}

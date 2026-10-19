import { useLayoutEffect, useEffectEvent, useRef, useState } from "react";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  isLeaderNavigationShortcut,
  isNavigationKeyEvent,
  menuControlDirection,
} from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import {
  createMessageNavigation,
  composerElement,
  discloseSidebar,
  focusComposer,
  focusSidebar,
  leaderTargetContext,
  LEADER_OPEN_EVENT,
  moveMenu,
  moveContextMenu,
  movePalette,
  moveSidebar,
} from "./LeaderNavigation.dom";

export type LeaderNavigationAction = Pick<CommandPaletteActionItem, "run"> & {
  readonly key: string;
  readonly label: string;
  readonly shortcut?: string | null;
};
export interface LeaderNavigationGroup {
  readonly key: string;
  readonly label: string;
  readonly actions: readonly LeaderNavigationAction[];
}

const noSidebarTransition = async () => {};

export function LeaderNavigation({
  groups,
  isClaimed,
  showSidebar,
  leaveSidebar = noSidebarTransition,
}: {
  readonly groups: readonly LeaderNavigationGroup[];
  readonly isClaimed: (event: KeyboardEvent) => boolean;
  readonly showSidebar: () => void;
  readonly leaveSidebar?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState<string | null>(null);
  const [mode, setMode] = useState<"messages" | "sidebar" | null>(null);
  const [messageAvailable, setMessageAvailable] = useState(false);
  const [messages] = useState(createMessageNavigation);
  const returnFocus = useRef<HTMLElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);
  const pendingAction = useRef<(() => void) | null>(null);
  const observer = useRef<MutationObserver | null>(null);
  const focusGeneration = useRef(0);
  const pendingFocus = useRef(false);
  const selectedGroup = groups.find((item) => item.key === group);
  const finishMode = () => {
    messages.clear();
    setMode(null);
  };
  const afterSidebar = async (action: () => void) => {
    const generation = ++focusGeneration.current;
    pendingFocus.current = true;
    await leaveSidebar();
    if (focusGeneration.current !== generation) return;
    pendingFocus.current = false;
    requestAnimationFrame(() => {
      if (focusGeneration.current === generation) action();
    });
  };
  const restoreModeFocus = () => {
    const target = returnFocus.current;
    void afterSidebar(() => {
      if (target === composerElement() || target === document.body || !target?.isConnected)
        focusComposer();
      else if (target?.isConnected) target.focus();
    });
  };
  const enter = (origin?: HTMLElement | null) => {
    finishMode();
    setMessageAvailable(document.querySelector("[data-message-id][data-message-role]") !== null);
    returnFocus.current =
      origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setGroup(null);
    setOpen(true);
  };
  const select = (action: () => void) => {
    pendingAction.current = action;
    setOpen(false);
  };
  const enterMessages = () => {
    void afterSidebar(() => {
      if (messages.enter()) setMode("messages");
      else focusComposer();
    });
  };
  const enterComposer = () => {
    void afterSidebar(() => {
      focusComposer();
    });
  };
  const enterSidebar = () => {
    showSidebar();
    requestAnimationFrame(() => {
      if (focusSidebar()) setMode("sidebar");
    });
  };
  const focusEntry = (direction: -1 | 1) => {
    const entries = [
      ...(popup.current?.querySelectorAll<HTMLButtonElement>("[data-leader-key]:not(:disabled)") ??
        []),
    ];
    const current = entries.indexOf(document.activeElement as HTMLButtonElement);
    entries[(current + direction + entries.length) % entries.length]?.focus();
  };
  const changeGroup = (key: string | null) => {
    setGroup(key);
    requestAnimationFrame(() =>
      popup.current?.querySelector<HTMLButtonElement>("[data-leader-key]")?.focus(),
    );
  };
  const consume = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    if (pendingFocus.current && isEditableFocused(event.target)) focusGeneration.current++;
    if (!isNavigationKeyEvent(event)) return;
    const controlDirection = menuControlDirection(event);
    if (open) {
      if (controlDirection !== null || event.key === "ArrowDown" || event.key === "ArrowUp") {
        consume(event);
        focusEntry(controlDirection ?? (event.key === "ArrowDown" ? 1 : -1));
      } else if ((event.key === "Backspace" || event.key === "ArrowLeft") && group !== null) {
        consume(event);
        changeGroup(null);
      } else if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat) {
        const key = event.key.toLowerCase();
        if (selectedGroup) {
          const action = selectedGroup.actions.find((item) => item.key === key);
          if (action) {
            consume(event);
            select(() => {
              void action.run();
            });
          } else if (selectedGroup.key === "s" && key === "f") {
            consume(event);
            select(enterSidebar);
          }
        } else {
          const target = groups.find((item) => item.key === key);
          if (target) {
            consume(event);
            changeGroup(target.key);
          } else if (key === "m" && messageAvailable) {
            consume(event);
            select(enterMessages);
          } else if (key === "i") {
            consume(event);
            select(enterComposer);
          }
        }
      }
      return;
    }
    if (
      controlDirection !== null &&
      (moveMenu(controlDirection) || movePalette(controlDirection))
    ) {
      consume(event);
      return;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      moveContextMenu(event.key === "ArrowDown" ? 1 : -1)
    ) {
      consume(event);
      return;
    }
    const context = leaderTargetContext(event.target);
    const inSidebar =
      mode === "sidebar" &&
      event.target instanceof Element &&
      event.target.closest('[data-app-sidebar],[data-mobile="true"][data-sidebar="sidebar"]') !==
        null &&
      event.target.closest('[role="menu"],[role="listbox"],[data-keybinding-capture]') === null;
    if (mode && !context.editable && (!context.blocked || inSidebar)) {
      if (event.key === "Escape") {
        consume(event);
        finishMode();
        restoreModeFocus();
        return;
      }
      if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
        const key = event.key.toLowerCase();
        if (key === "i") {
          consume(event);
          finishMode();
          enterComposer();
          return;
        }
        const vertical =
          key === "j" || key === "arrowdown" ? 1 : key === "k" || key === "arrowup" ? -1 : null;
        const horizontal =
          key === "l" || key === "arrowright" ? 1 : key === "h" || key === "arrowleft" ? -1 : null;
        if (vertical !== null) {
          consume(event);
          if (mode === "messages") messages.move(vertical);
          else moveSidebar(vertical);
          return;
        }
        if (horizontal !== null) {
          consume(event);
          if (mode === "messages") messages.action(horizontal);
          else discloseSidebar(horizontal > 0);
          return;
        }
      }
    }
    if (isLeaderNavigationShortcut(event, { ...context, claimed: isClaimed(event) })) {
      consume(event);
      enter();
    }
  });

  const requestOpen = useEffectEvent(() => {
    observer.current?.disconnect();
    // The palette restores the composer on exit. Open after that restoration,
    // so two modal focus scopes never compete for the same keyboard gesture.
    if (document.querySelector("[data-command-palette]")) {
      const origin = composerElement();
      observer.current = new MutationObserver(() => {
        if (document.querySelector("[data-command-palette]")) return;
        observer.current?.disconnect();
        observer.current = null;
        requestAnimationFrame(() => {
          enter(origin);
        });
      });
      observer.current.observe(document.body, { childList: true, subtree: true });
    } else enter();
  });
  const focusChanged = useEffectEvent((event: FocusEvent) => {
    if (mode && isEditableFocused(event.target)) finishMode();
  });
  const lostFocus = useEffectEvent(() => {
    focusGeneration.current++;
    pendingFocus.current = false;
    observer.current?.disconnect();
    observer.current = null;
    pendingAction.current = null;
    setOpen(false);
    finishMode();
  });
  // Claim explicit navigation before the chat's passive type-to-focus listener.
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => handleKey(event);
    const request = () => requestOpen();
    const focus = (event: FocusEvent) => focusChanged(event);
    const blur = () => lostFocus();
    const pointer = () => {
      if (pendingFocus.current) focusGeneration.current++;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener(LEADER_OPEN_EVENT, request);
    document.addEventListener("focusin", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener(LEADER_OPEN_EVENT, request);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerdown", pointer, true);
      focusGeneration.current++;
      observer.current?.disconnect();
      pendingAction.current = null;
      messages.clear();
    };
  }, [messages]);

  return (
    <>
      <style>
        {
          "[data-leader-message-focus] { outline: 2px solid var(--ring); outline-offset: 4px; border-radius: var(--radius); }"
        }
      </style>
      {mode ? (
        <div className="fixed bottom-4 left-1/2 z-40 w-max max-w-[calc(100vw_-_2rem)] -translate-x-1/2">
          <div className="flex flex-wrap items-center justify-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm">
            <span role="status">{mode === "messages" ? "Messages" : "Sidebar"}</span>
            <span className="inline-flex items-center gap-1">
              <Kbd>J/K</Kbd>
              {mode === "messages" ? "messages" : "rows"}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>H/L</Kbd>
              {mode === "messages" ? "actions" : "fold"}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>I</Kbd>compose
            </span>
            <Kbd>Esc</Kbd>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                finishMode();
                restoreModeFocus();
              }}
              aria-label={`Exit ${mode} navigation`}
            >
              <span aria-hidden>×</span>
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && pendingAction.current) {
            const action = pendingAction.current;
            requestAnimationFrame(() => {
              if (pendingAction.current !== action) return;
              pendingAction.current = null;
              action();
            });
          }
        }}
      >
        <DialogPopup
          ref={popup}
          aria-label="Keyboard navigation"
          initialFocus={() =>
            popup.current?.querySelector<HTMLButtonElement>("[data-leader-key]") ?? false
          }
          finalFocus={() =>
            pendingAction.current || document.visibilityState === "hidden"
              ? false
              : returnFocus.current?.isConnected
                ? returnFocus.current
                : false
          }
        >
          <DialogHeader>
            <DialogTitle>
              <span className="flex items-center gap-2">
                <Kbd className="shrink-0">Space</Kbd>
                {selectedGroup ? `› ${selectedGroup.label}` : "Keyboard navigation"}
              </span>
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {(selectedGroup ? selectedGroup.actions : groups).map((item) => (
                <Button
                  key={item.key}
                  data-leader-key={item.key}
                  variant="ghost"
                  onClick={() => {
                    if ("run" in item)
                      select(() => {
                        void item.run();
                      });
                    else changeGroup(item.key);
                  }}
                >
                  <span className="flex w-full items-center gap-3">
                    <Kbd>{item.key.toUpperCase()}</Kbd>
                    <span className="flex-1 text-left">{item.label}</span>
                    {"shortcut" in item && item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
                  </span>
                </Button>
              ))}
              {!selectedGroup ? (
                <>
                  <Button
                    data-leader-key="m"
                    variant="ghost"
                    disabled={!messageAvailable}
                    onClick={() => select(enterMessages)}
                  >
                    <span className="flex w-full items-center gap-3">
                      <Kbd>M</Kbd>Navigate messages
                    </span>
                  </Button>
                  <Button data-leader-key="i" variant="ghost" onClick={() => select(enterComposer)}>
                    <span className="flex w-full items-center gap-3">
                      <Kbd>I</Kbd>Focus composer
                    </span>
                  </Button>
                </>
              ) : selectedGroup.key === "s" ? (
                <Button data-leader-key="f" variant="ghost" onClick={() => select(enterSidebar)}>
                  <span className="flex w-full items-center gap-3">
                    <Kbd>F</Kbd>Navigate rows
                  </span>
                </Button>
              ) : null}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Kbd>↑ ↓</Kbd>
              <Kbd>Ctrl N/P</Kbd>
              {group ? (
                <>
                  <Kbd>←</Kbd>
                  <span>Back</span>
                </>
              ) : null}
              <Kbd>Esc</Kbd>
              <span>Return</span>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

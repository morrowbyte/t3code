import { useLayoutEffect, useEffectEvent, useRef, useState } from "react";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import {
  isLeaderNavigationShortcut,
  isNavigationKeyEvent,
  menuControlDirection,
} from "../../keybindings";
import { isEditableFocused } from "../../lib/editableFocus";
import { dismissContextMenu, isContextMenuOpen } from "../../contextMenuFallback";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Kbd } from "../ui/kbd";
import {
  isNavigationMode,
  leaveNavigationMode,
  NAVIGATION_MODE_EVENT,
  requestNavigationMode,
} from "./navigationMode";
import { dispatchKeyboardCommand, useKeyboardCommands } from "./keyboardCommands";
import { WorkbenchCommandPicker, type WorkbenchCommand } from "./WorkbenchCommandPicker";
import {
  activateKeyboardObject,
  contextControls,
  cycleWorkbenchRegion,
  hasLocalKeyboardNavigation,
  keyboardContextName,
  moveKeyboardObject,
} from "./regionNavigation";
import { KeyboardContextHelp } from "./KeyboardContextHelp";
import {
  createMessageNavigation,
  composerElement,
  discloseSidebar,
  focusComposer,
  focusSidebar,
  focusSidebarBoundary,
  leaderTargetContext,
  LEADER_OPEN_EVENT,
  moveMenu,
  moveContextMenu,
  movePalette,
  moveSidebar,
  openKeyboardLayers,
  dismissKeyboardLayer,
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
const noActivationShortcut = () => false;
const noNavigationShortcut = (): "navigation.contextActions" | "navigation.hints" | null => null;

function hasOpenKeyboardLayer() {
  return isContextMenuOpen() || openKeyboardLayers().length > 0;
}

function isPlainEscape(event: KeyboardEvent) {
  return (
    isNavigationKeyEvent(event) &&
    event.key === "Escape" &&
    !event.repeat &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
  );
}

export function LeaderNavigation({
  groups,
  isClaimed,
  isActivationShortcut = noActivationShortcut,
  resolveNavigationShortcut = noNavigationShortcut,
  showSidebar,
  leaveSidebar = noSidebarTransition,
  showComposer = noSidebarTransition,
  activationShortcutLabel,
}: {
  readonly groups: readonly LeaderNavigationGroup[];
  readonly isClaimed: (event: KeyboardEvent) => boolean;
  readonly isActivationShortcut?: (event: KeyboardEvent) => boolean;
  readonly resolveNavigationShortcut?: (
    event: KeyboardEvent,
  ) => "navigation.contextActions" | "navigation.hints" | null;
  readonly showSidebar: () => void;
  readonly leaveSidebar?: () => Promise<void>;
  readonly showComposer?: () => Promise<void>;
  readonly activationShortcutLabel?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [navigation, setNavigation] = useState(isNavigationMode);
  const [regionName, setRegionName] = useState("App");
  const [controls, setControls] = useState<readonly WorkbenchCommand[] | null>(null);
  const [controlsName, setControlsName] = useState("App");
  const [help, setHelp] = useState<{ target: HTMLElement | null } | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const groupState = useRef<string | null>(null);
  const openState = useRef(false);
  const [mode, setMode] = useState<"messages" | "sidebar" | null>(null);
  const [messageAvailable, setMessageAvailable] = useState(false);
  const [messages] = useState(createMessageNavigation);
  const returnFocus = useRef<HTMLElement | null>(null);
  const navigationStatus = useRef<HTMLDivElement | null>(null);
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
  const enter = (origin?: HTMLElement | null) => {
    requestNavigationMode();
    finishMode();
    setMessageAvailable(document.querySelector("[data-message-id][data-message-role]") !== null);
    returnFocus.current =
      origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setGroup(null);
    groupState.current = null;
    openState.current = true;
    setOpen(true);
  };
  const select = (action: () => void) => {
    openState.current = false;
    if (!popup.current) {
      setOpen(false);
      action();
      return;
    }
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
    leaveNavigationMode();
    void afterSidebar(() => {
      if (!focusComposer()) void showComposer();
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
    groupState.current = key;
    setGroup(key);
    requestAnimationFrame(() =>
      popup.current?.querySelector<HTMLButtonElement>("[data-leader-key]")?.focus(),
    );
  };
  const consume = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const returnToNavigation = (preserveContext = false) => {
    focusGeneration.current++;
    pendingFocus.current = false;
    if (openState.current) {
      openState.current = false;
      pendingAction.current = null;
      setOpen(false);
    }
    finishMode();
    const origin = document.activeElement;
    let target: HTMLElement | null = null;
    if (origin instanceof HTMLElement) {
      setRegionName(keyboardContextName(origin));
      if (preserveContext) {
        target = origin.closest<HTMLElement>(
          "[data-keyboard-object],[data-keyboard-region],[data-app-sidebar],[data-right-panel-surface-content]",
        );
        if (
          origin.closest(
            '[data-terminal-owner],[data-preview-panel-mode],[data-keyboard-object="Browser"],[data-keyboard-object="Terminal output"]',
          ) ||
          (target &&
            (leaderTargetContext(target).blocked || target.matches("[data-keyboard-local]")))
        )
          target = null;
      }
      origin.blur();
    }
    requestNavigationMode();
    if (target?.isConnected) {
      if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    const generation = focusGeneration.current;
    requestAnimationFrame(() => {
      if (
        generation === focusGeneration.current &&
        isNavigationMode() &&
        document.activeElement === document.body
      )
        navigationStatus.current?.focus({ preventScroll: true });
    });
  };

  const handleEscape = useEffectEvent((event: KeyboardEvent) => {
    // Local popups, suggestions and rename cancellation get the key first.
    if (!isPlainEscape(event) || hasOpenKeyboardLayer()) return;
    const generation = focusGeneration.current;
    const origin = document.activeElement;
    const tooltipTrigger =
      origin instanceof HTMLElement &&
      origin.matches("[data-base-ui-tooltip-trigger]") &&
      !isEditableFocused(origin) &&
      !leaderTargetContext(origin).blocked &&
      !hasLocalKeyboardNavigation(event);
    requestAnimationFrame(() => {
      if (
        // Base UI consumes Escape when dismissing a trigger's informational tooltip.
        (isPlainEscape(event) || (tooltipTrigger && event.defaultPrevented)) &&
        generation === focusGeneration.current &&
        document.activeElement === origin &&
        !hasOpenKeyboardLayer()
      )
        returnToNavigation();
    });
  });

  const activateNavigation = async () => {
    if (openState.current) {
      returnToNavigation();
      return;
    }
    const generation = ++focusGeneration.current;
    pendingFocus.current = true;
    let dismissed = isContextMenuOpen();
    if (dismissed) dismissContextMenu();
    for (let depth = 0; depth < 8; depth++) {
      const layer = dismissKeyboardLayer();
      if (!layer) break;
      dismissed = true;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.allSettled(layer.getAnimations().map((animation) => animation.finished));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (generation !== focusGeneration.current) return;
      if (openKeyboardLayers().includes(layer)) {
        pendingFocus.current = false;
        return;
      }
    }
    if (generation !== focusGeneration.current) return;
    pendingFocus.current = false;
    if (
      openKeyboardLayers().some(
        (layer) => !layer.matches('[data-mobile="true"][data-sidebar="sidebar"]'),
      )
    )
      return;
    returnToNavigation(!dismissed);
  };

  const handleKey = useEffectEvent((event: KeyboardEvent) => {
    const group = groupState.current;
    const selectedGroup = groups.find((item) => item.key === group);
    if (pendingFocus.current && isEditableFocused(event.target) && !isActivationShortcut(event))
      focusGeneration.current++;
    if (!isNavigationKeyEvent(event)) return;
    if (
      event.key === "F6" &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      ![
        ...document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"],[role="alertdialog"],[data-slot="dialog-popup"],[data-slot="sheet-popup"],[role="menu"],[role="listbox"]',
        ),
      ].some(
        (element) =>
          !element.closest('[inert],[aria-hidden="true"]') &&
          element.getClientRects().length > 0 &&
          getComputedStyle(element).visibility !== "hidden",
      )
    ) {
      if (cycleWorkbenchRegion(event.shiftKey ? -1 : 1, isNavigationMode())) consume(event);
      return;
    }
    if (
      isActivationShortcut(event) &&
      !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]"))
    ) {
      consume(event);
      if (event.repeat) return;
      void activateNavigation();
      return;
    }
    const navigationCommand = resolveNavigationShortcut(event);
    if (
      navigationCommand &&
      !isEditableFocused(event.target) &&
      !hasLocalKeyboardNavigation(event)
    ) {
      consume(event);
      if (event.repeat) return;
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (navigationCommand === "navigation.contextActions") {
        setControlsName(keyboardContextName(returnFocus.current));
        setControls(contextControls(returnFocus.current));
      } else dispatchKeyboardCommand(navigationCommand);
      return;
    }
    const controlDirection = menuControlDirection(event);
    if (openState.current) {
      if (event.key === "Escape" && group !== null) {
        consume(event);
        changeGroup(null);
      } else if (
        controlDirection !== null ||
        event.key === "ArrowDown" ||
        event.key === "ArrowUp"
      ) {
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
      event.target instanceof Element &&
      event.target.closest('[data-app-sidebar],[data-mobile="true"][data-sidebar="sidebar"]') !==
        null &&
      event.target.closest('[role="menu"],[role="listbox"],[data-keybinding-capture]') === null &&
      event.target.closest('[data-keyboard-region="settings-navigation"]') === null &&
      (!context.blocked ||
        event.target
          .closest('[role="dialog"]')
          ?.matches('[data-mobile="true"][data-sidebar="sidebar"]') === true);
    if (
      isNavigationMode() &&
      !context.editable &&
      !isClaimed(event) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key === "?") {
        consume(event);
        setHelp({ target });
        return;
      }
      if (event.key === "F10" && event.shiftKey) {
        if (hasLocalKeyboardNavigation(event)) return;
        consume(event);
        returnFocus.current = target;
        setControlsName(keyboardContextName(target));
        setControls(contextControls(target));
        return;
      }
      if (
        !context.blocked &&
        !hasLocalKeyboardNavigation(event) &&
        !mode &&
        !inSidebar &&
        !event.shiftKey
      ) {
        if (
          (event.key === "j" || event.key === "k") &&
          moveKeyboardObject(target, event.key === "j" ? 1 : -1)
        ) {
          consume(event);
          return;
        }
        if (event.key === "Enter" && activateKeyboardObject(target)) {
          consume(event);
          return;
        }
        if (
          (event.key === "h" || event.key === "l") &&
          cycleWorkbenchRegion(event.key === "h" ? -1 : 1, true)
        ) {
          consume(event);
          return;
        }
      }
    }
    if (isNavigationMode() && !context.editable && !context.blocked && !isClaimed(event)) {
      if (event.key.toLowerCase() === "i" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        consume(event);
        finishMode();
        enterComposer();
        return;
      }
    }
    const activeMode = inSidebar && isNavigationMode() ? "sidebar" : mode;
    if (
      activeMode &&
      !context.editable &&
      (!context.blocked || inSidebar) &&
      !hasLocalKeyboardNavigation(event) &&
      !isClaimed(event)
    ) {
      if (event.key === "Escape") {
        consume(event);
        returnToNavigation();
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
          if (activeMode === "messages") messages.move(vertical);
          else moveSidebar(vertical);
          return;
        }
        if (horizontal !== null) {
          consume(event);
          if (activeMode === "messages") messages.action(horizontal);
          else discloseSidebar(horizontal > 0);
          return;
        }
        if (activeMode === "sidebar" && (key === "home" || key === "end")) {
          if (focusSidebarBoundary(key === "end")) consume(event);
          return;
        }
      }
    }
    if (
      isLeaderNavigationShortcut(event, {
        ...context,
        interactive: isNavigationMode() ? false : context.interactive,
        claimed: isClaimed(event),
      })
    ) {
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
    if (
      event.target instanceof HTMLElement &&
      !event.target.closest('[data-slot="dialog-popup"],[aria-label="App navigation"]')
    )
      setRegionName(keyboardContextName(event.target));
    if (event.target === composerElement()) leaveNavigationMode();
    if (mode && event.target instanceof Element) {
      const inRegion =
        mode === "sidebar"
          ? event.target.closest("[data-app-sidebar],[data-mobile='true'][data-sidebar='sidebar']")
          : event.target.closest("[data-message-id][data-message-role]");
      if (!inRegion || isEditableFocused(event.target) || hasLocalKeyboardNavigation(event))
        finishMode();
    }
  });
  const lostFocus = useEffectEvent(() => {
    focusGeneration.current++;
    pendingFocus.current = false;
    observer.current?.disconnect();
    observer.current = null;
    pendingAction.current = null;
    setOpen(false);
    openState.current = false;
    finishMode();
  });
  // Claim explicit navigation before the chat's passive type-to-focus listener.
  useLayoutEffect(() => {
    const key = (event: KeyboardEvent) => {
      handleKey(event);
      handleEscape(event);
    };
    const request = () => requestOpen();
    const focus = (event: FocusEvent) => focusChanged(event);
    const blur = () => lostFocus();
    const navigationChanged = () => setNavigation(isNavigationMode());
    const pointer = () => {
      if (pendingFocus.current) focusGeneration.current++;
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener(LEADER_OPEN_EVENT, request);
    window.addEventListener(NAVIGATION_MODE_EVENT, navigationChanged);
    document.addEventListener("focusin", focus);
    window.addEventListener("blur", blur);
    document.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener(LEADER_OPEN_EVENT, request);
      window.removeEventListener(NAVIGATION_MODE_EVENT, navigationChanged);
      document.removeEventListener("focusin", focus);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerdown", pointer, true);
      focusGeneration.current++;
      observer.current?.disconnect();
      pendingAction.current = null;
      messages.clear();
    };
  }, [messages]);
  useKeyboardCommands({
    "navigation.contextActions": (origin) => {
      if (origin !== undefined) returnFocus.current = origin;
      setControlsName(keyboardContextName(returnFocus.current));
      setControls(contextControls(returnFocus.current));
    },
    "navigation.activate": () => {
      void activateNavigation();
    },
  });

  return (
    <>
      {help ? (
        <KeyboardContextHelp
          target={help.target}
          activationShortcutLabel={activationShortcutLabel ?? null}
          onClose={() => setHelp(null)}
          onActions={() => {
            setHelp(null);
            returnFocus.current = help.target;
            requestAnimationFrame(() => {
              setControlsName(keyboardContextName(help.target));
              setControls(contextControls(help.target));
            });
          }}
        />
      ) : null}
      {controls ? (
        <WorkbenchCommandPicker
          title={`${controlsName} actions`}
          commands={controls}
          onClose={() => setControls(null)}
        />
      ) : null}
      <style>
        {
          "[data-leader-message-focus], [data-keyboard-object]:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; border-radius: var(--radius); }"
        }
      </style>
      {mode || navigation ? (
        <div className="fixed bottom-4 left-1/2 z-40 w-max max-w-[calc(100vw_-_2rem)] -translate-x-1/2">
          <div
            ref={navigationStatus}
            tabIndex={-1}
            aria-label="App navigation"
            className="flex flex-wrap items-center justify-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-sm"
          >
            <span role="status">
              NORMAL · {mode ? (mode === "messages" ? "Messages" : "Sidebar") : regionName}
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Space</Kbd>actions
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>F6</Kbd>regions
            </span>
            <span className="inline-flex items-center gap-1">
              <Kbd>?</Kbd>help
            </span>
            {mode ? (
              <>
                <span className="inline-flex items-center gap-1">
                  <Kbd>J/K</Kbd>
                  {mode === "messages" ? "messages" : "rows"}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Kbd>H/L</Kbd>
                  {mode === "messages" ? "actions" : "fold"}
                </span>
              </>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <Kbd>I</Kbd>compose
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                finishMode();
                enterComposer();
              }}
              aria-label="Return to composer"
            >
              <span aria-hidden>×</span>
            </Button>
          </div>
        </div>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          openState.current = value;
          setOpen(value);
        }}
        onOpenChangeComplete={(isOpen) => {
          if (!isOpen && !pendingAction.current && isNavigationMode()) {
            requestAnimationFrame(() => navigationStatus.current?.focus({ preventScroll: true }));
          }
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
              : isNavigationMode()
                ? navigationStatus.current
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

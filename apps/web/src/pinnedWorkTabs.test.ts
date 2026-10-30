import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import {
  compileResolvedKeybindingsConfig,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { resolveShortcutCommand, threadJumpIndexFromCommand } from "./keybindings";
import { numericNavigationTarget, togglePinnedWorkTab } from "./pinnedWorkTabs";

const tab = (environment: string, thread = "same-thread") => ({
  environmentId: EnvironmentId.make(environment),
  threadId: ThreadId.make(thread),
  title: thread,
});

describe("pinned work tabs", () => {
  it("keeps identities distinct across environments and caps pins at five", () => {
    const first = tab("one");
    const second = tab("two");
    const pins = [first, second, tab("three"), tab("four"), tab("five")];
    expect(togglePinnedWorkTab([first], second)).toEqual([first, second]);
    expect(togglePinnedWorkTab(pins, tab("six"))).toBe(pins);
    expect(togglePinnedWorkTab(pins, second)).toEqual([first, ...pins.slice(2)]);
  });

  it("retains sidebar defaults and never falls through from empty pin slots or 6–9", () => {
    const first = tab("one");
    const sidebar = tab("sidebar");
    expect(numericNavigationTarget(DEFAULT_CLIENT_SETTINGS, 0, sidebar)).toBe(sidebar);
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      numericNavigationMode: "pinned-tabs" as const,
      pinnedWorkTabs: [first],
    };
    expect(numericNavigationTarget(settings, 0, sidebar)).toBe(first);
    for (let index = 1; index < 9; index++) {
      expect(numericNavigationTarget(settings, index, sidebar)).toBeNull();
    }
  });

  it("enables numeric commands for web pins while preserving shortcut conflicts", () => {
    const event = { key: "1", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
    const bindings = mergeWithDefaultKeybindings([]);
    const web = { platform: "Linux", context: { isWeb: true, isDesktop: false } };
    expect(resolveShortcutCommand(event, bindings, web)).toBeNull();
    const pins = { ...web, context: { ...web.context, pinnedTabsNavigation: true } };
    expect(threadJumpIndexFromCommand(resolveShortcutCommand(event, bindings, pins) ?? "")).toBe(0);
    expect(
      resolveShortcutCommand(
        event,
        mergeWithDefaultKeybindings(
          compileResolvedKeybindingsConfig([{ key: "mod+1", command: "chat.new" }]),
        ),
        pins,
      ),
    ).toBe("chat.new");
  });
});

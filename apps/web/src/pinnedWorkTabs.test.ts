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
  it("keeps identities distinct across environments and caps pins at eight", () => {
    const first = tab("one");
    const second = tab("two");
    const pins = [
      first,
      second,
      ...["three", "four", "five", "six", "seven", "eight"].map((id) => tab(id)),
    ];
    expect(togglePinnedWorkTab([first], second)).toEqual([first, second]);
    expect(togglePinnedWorkTab([first], { ...first, title: "Renamed" })).toEqual([]);
    expect(togglePinnedWorkTab(pins, tab("nine"))).toBe(pins);
    expect(togglePinnedWorkTab(pins, second)).toEqual([first, ...pins.slice(2)]);
  });

  it("retains sidebar defaults and never falls through from empty pin slots or 9", () => {
    const first = tab("one");
    const sidebar = tab("sidebar");
    expect(numericNavigationTarget(DEFAULT_CLIENT_SETTINGS, 0, sidebar)).toBe(sidebar);
    const settings = {
      ...DEFAULT_CLIENT_SETTINGS,
      numericNavigationMode: "pinned-tabs" as const,
      pinnedWorkTabs: [first],
    };
    expect(numericNavigationTarget(settings, 0, sidebar)).toBe(first);
    const full = {
      ...settings,
      pinnedWorkTabs: Array.from({ length: 8 }, (_, index) => tab(String(index))),
    };
    for (let index = 0; index < 8; index++) {
      expect(numericNavigationTarget(full, index, sidebar)).toBe(full.pinnedWorkTabs[index]);
      expect(numericNavigationTarget(DEFAULT_CLIENT_SETTINGS, index, sidebar)).toBe(sidebar);
    }
    expect(numericNavigationTarget(full, 8, sidebar)).toBeNull();
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
    for (const platform of ["Linux", "MacIntel"]) {
      for (let index = 0; index < 9; index++) {
        const shortcut = {
          ...event,
          key: String(index + 1),
          ctrlKey: platform === "Linux",
          metaKey: platform === "MacIntel",
        };
        expect(
          threadJumpIndexFromCommand(
            resolveShortcutCommand(shortcut, bindings, { ...pins, platform }) ?? "",
          ),
        ).toBe(index);
      }
    }
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

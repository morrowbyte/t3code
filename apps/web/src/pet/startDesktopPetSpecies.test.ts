import type { AnyRouter } from "@tanstack/react-router";
import { EnvironmentId, type AgentIdentityTheme } from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

type Settings = { agentIdentityTheme?: AgentIdentityTheme } | null;
const state = vi.hoisted(() => ({
  settings: null as ((id: EnvironmentId) => Atom.Writable<Settings>) | null,
  primary: null as Atom.Writable<EnvironmentId | null> | null,
  legacy: "neutral" as AgentIdentityTheme,
  onLegacy: () => {},
}));

vi.mock("../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  state.settings = Atom.family((_id: EnvironmentId) => Atom.make<Settings>(null));
  return { serverEnvironment: { settingsValueAtom: (id: EnvironmentId) => state.settings!(id) } };
});
vi.mock("../state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  state.primary = Atom.make<EnvironmentId | null>(null);
  return { primaryEnvironmentIdAtom: state.primary };
});
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({ getDraftSession: () => null }),
    subscribe: () => () => {},
  },
}));
vi.mock("../hooks/useLocalStorage", () => ({
  readLocalStorageValue: () => state.legacy,
  subscribeLocalStorageKey: (_key: string, listener: () => void) => {
    state.onLegacy = listener;
    return () => {
      state.onLegacy = () => {};
    };
  },
}));

import { startDesktopPetSpecies } from "./startDesktopPetSpecies";

function setup() {
  state.legacy = "neutral";
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task; task = tasks.shift()) task();
  };
  const first = EnvironmentId.make("first-environment");
  const second = EnvironmentId.make("second-environment");
  // Connected environments retain their config independently of the pet subscription.
  const stopEnvironments = [
    registry.mount(state.settings!(first)),
    registry.mount(state.settings!(second)),
  ];
  registry.set(state.primary!, second);
  registry.set(state.settings!(first), { agentIdentityTheme: "weasel" });
  registry.set(state.settings!(second), { agentIdentityTheme: "fox" });
  const listeners = new Set<() => void>();
  const route = {
    state: {
      matches: [{ params: { environmentId: first as string, threadId: "first-thread" } }],
      location: { pathname: `/${first}/first-thread` },
    },
    subscribe: (_event: string, listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const select = vi.fn(async () => null);
  vi.stubGlobal("window", { desktopBridge: { setPetSpecies: select } });
  const stop = startDesktopPetSpecies(registry, route as unknown as AnyRouter);
  flush();
  return {
    registry,
    first,
    second,
    select,
    flush,
    navigate(environmentId: EnvironmentId | null, pathname: string) {
      route.state.matches = [
        {
          params: {
            environmentId: environmentId ?? "",
            threadId: environmentId ? "thread" : "",
          },
        },
      ];
      route.state.location.pathname = pathname;
      for (const listener of listeners) listener();
      flush();
    },
    [Symbol.dispose]() {
      stop();
      for (const unmount of stopEnvironments) unmount();
      registry.dispose();
      vi.unstubAllGlobals();
    },
  };
}

it("follows the open environment and preserves it while Settings is open", () => {
  using h = setup();
  expect(h.select.mock.calls).toEqual([["weasel"]]);
  h.registry.set(state.settings!(h.second), { agentIdentityTheme: "dog" });
  h.flush();
  expect(h.select).toHaveBeenCalledTimes(1);
  h.navigate(null, "/settings/general");
  h.registry.set(state.settings!(h.first), { agentIdentityTheme: "cat" });
  h.flush();
  expect(h.select.mock.calls).toEqual([["weasel"], ["cat"]]);
  h.navigate(h.second, `/${h.second}/thread`);
  expect(h.select.mock.calls).toEqual([["weasel"], ["cat"], ["dog"]]);
});

it("uses the same legacy fallback as avatars without overriding an explicit environment preference", () => {
  using h = setup();
  h.registry.set(state.settings!(h.first), {});
  h.flush();
  expect(h.select).toHaveBeenLastCalledWith(null);
  state.legacy = "otter";
  state.onLegacy();
  expect(h.select).toHaveBeenLastCalledWith("otter");
  h.registry.set(state.settings!(h.first), { agentIdentityTheme: "cat" });
  h.flush();
  const calls = h.select.mock.calls.length;
  state.legacy = "bear";
  state.onLegacy();
  expect(h.select).toHaveBeenCalledTimes(calls);
  expect(h.select).toHaveBeenLastCalledWith("cat");
});

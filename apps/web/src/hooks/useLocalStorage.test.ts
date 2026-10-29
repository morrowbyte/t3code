import * as Schema from "effect/Schema";
import { AgentIdentityTheme, AGENT_IDENTITY_THEME_OPTIONS } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("local storage errors", () => {
  it("retries when access to browser storage becomes available", async () => {
    const storage = createStorage();
    storage.setItem("read-key", JSON.stringify("saved value"));
    let blocked = true;
    vi.stubGlobal("window", {
      get localStorage() {
        if (blocked) throw new Error("storage unavailable");
        return storage;
      },
    });
    const { getLocalStorageItem, LocalStorageOperationError } = await import("./useLocalStorage");

    expect(() => getLocalStorageItem("read-key", Schema.String)).toThrow(
      LocalStorageOperationError,
    );
    blocked = false;
    expect(getLocalStorageItem("read-key", Schema.String)).toBe("saved value");
  });
});

describe("agent identity theme storage", () => {
  it("round-trips every theme under the existing local preference key", async () => {
    const storage = createStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const { getLocalStorageItem, setLocalStorageItem } = await import("./useLocalStorage");
    const key = "t3code:agent-identity-theme";
    for (const { value } of AGENT_IDENTITY_THEME_OPTIONS) {
      setLocalStorageItem(key, value, AgentIdentityTheme);
      expect(storage.getItem(key)).toBe(JSON.stringify(value));
      expect(getLocalStorageItem(key, AgentIdentityTheme)).toBe(value);
    }
  });
});

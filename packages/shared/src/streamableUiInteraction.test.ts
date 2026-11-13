import { expect, it } from "vite-plus/test";
import { createVisualInteractionStore } from "./streamableUiInteraction";

it("bounds retained choices, notifies matching consumers and releases subscriptions", () => {
  const store = createVisualInteractionStore(2);
  let firstNotifications = 0;
  const unsubscribe = store.subscribe("thread-a/result", () => firstNotifications++);
  const initial = store.read("thread-a/result");
  expect(store.read("thread-a/result")).toBe(initial);
  store.write("thread-a/result", (previous) => ({ ...previous, hidden: ["target"] }));
  expect(firstNotifications).toBe(1);
  expect(store.read("thread-a/result").hidden).toEqual(["target"]);
  expect(store.read("thread-b/result").hidden).toEqual([]);
  store.write("thread-b/result", (previous) => ({ ...previous, selected: "cost" }));
  expect(firstNotifications).toBe(1);
  store.write("thread-c/result", (previous) => ({ ...previous, hidden: ["actual"] }));
  expect(store.read("thread-a/result")).toBe(initial);
  expect(firstNotifications).toBe(2);
  unsubscribe();
  store.write("thread-a/result", (previous) => ({ ...previous, selected: "benefit" }));
  expect(firstNotifications).toBe(2);
});

import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  available: true,
  threads: [] as EnvironmentThreadShell[],
  allowed: true,
  active: false,
  queueHeld: false,
  calls: [] as unknown[],
  navigate: vi.fn(),
  release: null as (() => void) | null,
}));

vi.mock(import("./availability"), () => ({
  isThreadCoordinationAvailable: () => fixture.available,
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => fixture.navigate,
}));
vi.mock(import("../../state/entities"), () => ({
  useThreadShell: (ref: ScopedThreadRef | null) =>
    fixture.threads.find((t) => t.id === ref?.threadId) ?? null,
  useThreadShells: () => fixture.threads,
}));
vi.mock(import("../../state/session"), () => ({ readEnvironmentScope: () => fixture.allowed }));
vi.mock(import("../../state/shell"), () => ({ useEnvironmentShellStatus: () => "live" }));
vi.mock(import("../../state/orchestration"), () => {
  return {
    orchestrationEnvironment: {
      v2: {
        dispatchCommand: {
          permissionAtom: () => permissionAtom,
        },
      },
    } as never,
  };
});
vi.mock(import("../../state/threads"), async () => {
  const Option = await import("effect/Option");
  const command = {
    label: "fixture-normal-thread-command",
    run: async (_registry: unknown, input: unknown) => {
      fixture.calls.push(input);
      await new Promise<void>((resolve) => {
        fixture.release = resolve;
      });
      return { _tag: "Success" as const, value: { sequence: 1 }, waiting: false };
    },
  };
  return {
    threadEnvironment: { startTurn: command, interruptTurn: command } as never,
    useEnvironmentThread: ((_environmentId: unknown, threadId: string | null) => ({
      status: "live",
      error: Option.none(),
      data: Option.some({
        thread: { id: threadId },
        runs: [
          ...(fixture.active ? [{ id: "fixture-active-run", status: "running" }] : []),
          ...(fixture.queueHeld
            ? [{ id: "fixture-held-run", status: "queued", queueHeld: true }]
            : []),
        ],
      }),
    })) as never,
  };
});

import { ThreadCoordination } from "./ThreadCoordination";

const permissionAtom = Atom.make(true);
const permissionRegistry = AtomRegistry.make();
afterAll(() => permissionRegistry.dispose());

let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  fixture.release?.();
  await act(async () => root?.unmount());
  container?.remove();
  localStorage.clear();
  fixture.available = true;
  vi.restoreAllMocks();
});

const environmentId = EnvironmentId.make("wea31-fixture");
const makeThreads = () =>
  ["coordinator", "one", "two"].map(
    (id) =>
      ({
        environmentId,
        id: ThreadId.make(id),
        title: `WEA31 stopped fixture ${id}`,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: ThreadId.make(id),
        },
        archivedAt: null,
        deletedAt: null,
        snoozedUntil: null,
        goal: null,
        runtimeMode: "approval-required",
        interactionMode: "default",
      }) as EnvironmentThreadShell,
  );

it.each(["[]", '["one","missing-thread"]', "invalid old state"])(
  "leaves dormant group state untouched and never mounts coordination (%s)",
  async (stored) => {
    const availability = await vi.importActual<typeof import("./availability")>("./availability");
    expect(availability.isThreadCoordinationAvailable()).toBe(false);
    fixture.available = availability.isThreadCoordinationAvailable();
    fixture.threads = makeThreads();
    fixture.calls = [];
    const key = `t3code:thread-coordination:v1:${JSON.stringify([environmentId, "coordinator"])}`;
    localStorage.setItem(key, stored);
    const read = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <ThreadCoordination
          threadRef={{ environmentId, threadId: ThreadId.make("coordinator") }}
        />,
      ),
    );
    expect(container.childElementCount).toBe(0);
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(fixture.calls).toEqual([]);
    expect(localStorage.getItem(key)).toBe(stored);
  },
);

it("keeps a reversible local group across remount and dispatches once to the selected original", async () => {
  fixture.threads = makeThreads();
  fixture.calls = [];
  fixture.allowed = true;
  permissionRegistry.set(permissionAtom, true);
  const originals = structuredClone(fixture.threads);
  const threadRef = { environmentId, threadId: ThreadId.make("coordinator") };
  container = document.createElement("div");
  document.body.append(container);
  const mount = async () => {
    root = createRoot(container!);
    await act(async () =>
      root!.render(
        <RegistryContext.Provider value={permissionRegistry}>
          <ThreadCoordination threadRef={threadRef} />
        </RegistryContext.Provider>,
      ),
    );
  };
  const click = async (label: string) => {
    const button = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  await mount();
  for (const id of ["one", "two"]) {
    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = id;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("Add member");
  }
  expect(container.querySelectorAll("li")).toHaveLength(2);
  await act(async () => root!.unmount());
  await mount();
  expect(container.querySelectorAll("li")).toHaveLength(2);
  await act(async () =>
    container!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
  );
  await click("Open original");
  expect(fixture.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId: "two" },
  });
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Harmless intercepted fixture message",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Send message");
  await click("Send message");
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({
    environmentId,
    input: {
      threadId: "two",
      dispatchMode: "queue",
      runtimeMode: "approval-required",
      message: { text: "Harmless intercepted fixture message", attachments: [] },
    },
  });
  await act(async () => fixture.release!());
  expect(container.textContent).toContain("Completion is not confirmed");
  expect(fixture.threads).toEqual(originals);
  await click("Remove");
  expect(container.querySelectorAll("li")).toHaveLength(1);
  await act(async () => root!.unmount());
  await mount();
  expect(container.querySelectorAll("li")).toHaveLength(1);
  await act(async () => {
    fixture.allowed = false;
    permissionRegistry.set(permissionAtom, false);
  });
  await act(async () => container!.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  expect(container.textContent).toContain("read-only");
  expect(fixture.calls).toHaveLength(1);
});

it("steers and cancels only the selected run and blocks held, paused and archived members", async () => {
  fixture.threads = makeThreads();
  fixture.calls = [];
  fixture.allowed = true;
  permissionRegistry.set(permissionAtom, true);
  fixture.active = true;
  localStorage.setItem(
    `t3code:thread-coordination:v1:${JSON.stringify([environmentId, "coordinator"])}`,
    JSON.stringify(["one", "two"]),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = () =>
    root!.render(
      <RegistryContext.Provider value={permissionRegistry}>
        <ThreadCoordination threadRef={{ environmentId, threadId: ThreadId.make("coordinator") }} />
      </RegistryContext.Provider>,
    );
  await act(async () => render());
  await act(async () =>
    container!.querySelectorAll<HTMLInputElement>('input[type="radio"]')[1]!.click(),
  );
  const textarea = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      textarea,
      "Intercepted steer",
    );
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const button = (label: string) =>
    Array.from(container!.querySelectorAll("button")).find((b) => b.textContent === label)!;
  await act(async () => button("Steer active turn").click());
  expect(fixture.calls).toHaveLength(1);
  expect(fixture.calls[0]).toMatchObject({
    environmentId,
    input: { threadId: "two", dispatchMode: "steer" },
  });
  await act(async () => fixture.release!());
  await act(async () => button("Cancel active turn").click());
  expect(fixture.calls).toHaveLength(2);
  expect(fixture.calls[1]).toEqual({
    environmentId,
    input: { threadId: "two", runId: "fixture-active-run" },
  });
  await act(async () => fixture.release!());
  fixture.queueHeld = true;
  await act(async () => render());
  expect(container.textContent).toContain("queue is paused");
  expect(button("Cancel active turn").disabled).toBe(true);
  fixture.queueHeld = false;
  for (const protection of [
    { goal: { status: "paused" } as EnvironmentThreadShell["goal"] },
    { goal: null, archivedAt: "2026-10-19" },
  ]) {
    fixture.threads[2] = { ...fixture.threads[2]!, ...protection };
    await act(async () => render());
    for (const label of ["Send message", "Steer active turn", "Cancel active turn"]) {
      expect(button(label).disabled).toBe(true);
      await act(async () => button(label).click());
    }
  }
  expect(fixture.calls).toHaveLength(2);
  fixture.active = false;
});

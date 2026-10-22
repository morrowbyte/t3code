import { EnvironmentId, ThreadId, type AgentAvatarState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  result: null as AsyncResult.AsyncResult<AgentAvatarState, Error> | null,
  reads: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: null }));
vi.mock("./query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("@t3tools/client-runtime/state/runtime", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    createEnvironmentRpcQueryAtomFamily: () => {
      const queries = Atom.family((_key: string) =>
        Atom.make(() => {
          state.reads();
          if (state.result === null) throw new Error("Missing query result");
          return state.result;
        }),
      );
      return (target: unknown) => queries(JSON.stringify(target));
    },
    createEnvironmentRpcCommand: () => ({}),
    squashAtomCommandFailure: vi.fn(),
  };
});

import { agentAvatarRead } from "./agentAvatars";

describe("avatar reads", () => {
  function setup(status: AgentAvatarState["status"]) {
    vi.useFakeTimers();
    state.reads.mockClear();
    const target = {
      environmentId: EnvironmentId.make("avatar-environment"),
      input: { threadId: ThreadId.make("avatar-thread"), theme: "neutral" as const },
    };
    const value: AgentAvatarState = {
      ...target.input,
      status,
      attachmentId: null,
      mimeType: null,
      error: null,
      updatedAt: null,
    };
    state.result = AsyncResult.success(value);
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
    const query = agentAvatarRead(target);
    const unmount = registry.mount(query);
    flush();
    return {
      registry,
      query,
      target,
      value,
      flush,
      [Symbol.dispose]() {
        unmount();
        registry.dispose();
        vi.useRealTimers();
      },
    };
  }

  it("shares one polling query across labels and stops when the generated image is ready", () => {
    using h = setup("generating");
    const second = agentAvatarRead({ ...h.target, input: { ...h.target.input } });
    expect(second).toBe(h.query);
    expect(
      agentAvatarRead({ ...h.target, input: { ...h.target.input, theme: "weasel" } }),
    ).not.toBe(h.query);
    expect(
      agentAvatarRead({ ...h.target, environmentId: EnvironmentId.make("another-environment") }),
    ).not.toBe(h.query);
    const unmountSecond = h.registry.mount(second);
    expect(state.reads).toHaveBeenCalledTimes(1);
    state.result = AsyncResult.success({ ...h.value, status: "ready", attachmentId: "portrait" });
    vi.advanceTimersByTime(2_000);
    h.flush();
    expect(state.reads).toHaveBeenCalledTimes(2);
    expect(AsyncResult.getOrElse(h.registry.get(second), () => null)?.attachmentId).toBe(
      "portrait",
    );
    vi.advanceTimersByTime(10_000);
    h.flush();
    expect(state.reads).toHaveBeenCalledTimes(2);
    unmountSecond();
  });

  it.each(["missing", "ready", "failed", "cancelled"] as const)(
    "does not poll %s avatars",
    (status) => {
      using h = setup(status);
      vi.advanceTimersByTime(10_000);
      h.flush();
      expect(state.reads).toHaveBeenCalledTimes(1);
    },
  );

  it("stops polling after a read failure", () => {
    using h = setup("generating");
    state.result = AsyncResult.failure(Cause.fail(new Error("Disconnected")));
    vi.advanceTimersByTime(2_000);
    h.flush();
    expect(h.registry.get(h.query)._tag).toBe("Failure");
    vi.advanceTimersByTime(10_000);
    h.flush();
    expect(state.reads).toHaveBeenCalledTimes(2);
  });
});

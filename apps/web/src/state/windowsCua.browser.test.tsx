import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type WindowsCuaStatus } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";

type InputStatus = WindowsCuaStatus & { inputPhase: "unknown" | "active" | "released" };
const makeControls = () => ({
  generation: Atom.make(1),
  presentation: Atom.make({ connection: { phase: "connected" } }),
});
const fixture = vi.hoisted(() => ({
  controls: undefined as ReturnType<typeof makeControls> | undefined,
  currentStatus: undefined as
    | ReturnType<typeof Atom.make<AsyncResult.AsyncResult<InputStatus>>>
    | undefined,
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/runtime", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    environmentSessionGenerationAtom: () => fixture.controls!.generation,
    createEnvironmentRpcSubscriptionAtomFamily: () => {
      const family = Atom.family((_environmentId: string) =>
        Atom.make<AsyncResult.AsyncResult<InputStatus>>(AsyncResult.initial()),
      );
      return ({ environmentId }: { environmentId: string }) => {
        const atom = family(environmentId);
        fixture.currentStatus = atom;
        return atom;
      };
    },
  };
});
vi.mock("./presentation", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useEnvironmentPresentation: () => ({
      isReady: true,
      presentation: useAtomValue(fixture.controls!.presentation),
    }),
  };
});

import { useWindowsCuaStatus } from "./windowsCua";

it("hides cached input release while disconnected and until the new session reports", async () => {
  fixture.controls = makeControls();
  fixture.currentStatus = undefined;
  const controls = fixture.controls;
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  const environmentId = EnvironmentId.make("cua-target");
  const snapshot: InputStatus = {
    environmentId,
    supported: true,
    enabled: true,
    phase: "ready",
    ownerThreadId: null,
    inputPhase: "released",
  };
  function Probe() {
    const query = useWindowsCuaStatus(environmentId);
    const data = query.data as (WindowsCuaStatus & { inputPhase?: string }) | null;
    return <output aria-label="Input phase">{data?.inputPhase ?? "unknown"}</output>;
  }
  await using screen = await render(
    <RegistryContext.Provider value={registry}>
      <Probe />
    </RegistryContext.Provider>,
  );
  const phase = screen.getByLabelText("Input phase");
  const oldSession = fixture.currentStatus!;
  await act(() => registry.set(oldSession, AsyncResult.success(snapshot)));
  await expect.element(phase).toHaveTextContent("released");

  await act(() => registry.set(controls.presentation, { connection: { phase: "offline" } }));
  await expect.element(phase).toHaveTextContent("unknown");

  await act(() => {
    registry.set(controls.generation, 2);
    registry.set(controls.presentation, { connection: { phase: "connected" } });
  });
  await expect.element(phase).toHaveTextContent("unknown");
  const newSession = fixture.currentStatus!;
  expect(newSession).not.toBe(oldSession);
  await act(() => registry.set(oldSession, AsyncResult.success(snapshot)));
  await expect.element(phase).toHaveTextContent("unknown");

  await act(() => registry.set(newSession, AsyncResult.success(snapshot)));
  await expect.element(phase).toHaveTextContent("released");
  await act(() => registry.set(newSession, AsyncResult.waiting(AsyncResult.success(snapshot))));
  await expect.element(phase).toHaveTextContent("unknown");
  await act(() =>
    registry.set(newSession, AsyncResult.success({ ...snapshot, inputPhase: "active" })),
  );
  await expect.element(phase).toHaveTextContent("active");
});

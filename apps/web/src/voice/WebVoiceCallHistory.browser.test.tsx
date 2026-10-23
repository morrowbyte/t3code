import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ThreadId,
  type LiveVoiceCallHistory,
  type LiveVoiceCallSummary,
  type LiveVoiceCallTranscript,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";

const queries = vi.hoisted(() => ({ recent: vi.fn(), earlier: vi.fn(), transcript: vi.fn() }));
vi.mock("~/rpc/liveVoiceHistory", () => ({
  voiceCallHistoryQuery: queries.recent,
  earlierVoiceCallHistoryQuery: queries.earlier,
  voiceCallTranscriptQuery: queries.transcript,
}));
import { WebVoiceCallHistory } from "./WebVoiceCallHistory";

const environmentId = EnvironmentId.make("fixture-env");
const threadId = ThreadId.make("fixture-thread");
const call = (leaseId: string, startedAt: string): LiveVoiceCallSummary => ({
  leaseId,
  threadId,
  generation: 1,
  firstEventId: 1,
  lastEventId: 2,
  startedAt,
  activeAt: startedAt,
  endedAt: "2026-10-23T18:03:10.000Z",
  updatedAt: "2026-10-23T18:03:10.000Z",
  status: "closed",
});
const oldCall = call("first-call", "2026-10-23T18:00:00.000Z");
const newCall = call("second-call", "2026-10-23T18:02:00.000Z");
const history = (calls: ReadonlyArray<LiveVoiceCallSummary>): LiveVoiceCallHistory => ({
  calls,
  nextBefore: null,
  persistenceAvailable: true,
});

function setup() {
  vi.clearAllMocks();
  const registry = AtomRegistry.make();
  const head = Atom.make<AsyncResult.AsyncResult<LiveVoiceCallHistory, unknown>>(
    AsyncResult.success(history([])),
  );
  const older = Atom.make(AsyncResult.success(history([oldCall])));
  queries.recent.mockReturnValue(head);
  queries.earlier.mockReturnValue(older);
  const transcripts = new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<LiveVoiceCallTranscript>>
  >();
  queries.transcript.mockImplementation(
    ({ input }: { input: { threadId: ThreadId; leaseId: string; generation: number } }) => {
      let atom = transcripts.get(input.leaseId);
      if (!atom) {
        atom = Atom.make<AsyncResult.AsyncResult<LiveVoiceCallTranscript>>(
          AsyncResult.success({
            ...input,
            entries: [
              {
                id: "segment",
                speaker: "user",
                text: `${input.leaseId}: actual received speech`,
                final: true,
                occurredAt: "2026-10-23T18:00:01.000Z",
                updatedAt: "2026-10-23T18:00:02.000Z",
              },
            ],
            incomplete: false,
          } satisfies LiveVoiceCallTranscript),
        );
        transcripts.set(input.leaseId, atom);
      }
      return atom;
    },
  );
  return {
    registry,
    head,
    ui: () => (
      <RegistryContext.Provider value={registry}>
        <WebVoiceCallHistory environmentId={environmentId} threadId={threadId} />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("keeps ended calls available, opens separate transcripts and retrieves them again after remount", async () => {
  using fixture = setup();
  await using screen = await render(fixture.ui());
  expect(screen.container.querySelectorAll("[aria-expanded]")).toHaveLength(0);
  await act(() =>
    fixture.registry.set(
      fixture.head,
      AsyncResult.success(history([{ ...newCall, status: "active", endedAt: null }, oldCall])),
    ),
  );
  expect(screen.container.textContent).toContain("Live");
  await act(() =>
    fixture.registry.set(fixture.head, AsyncResult.success(history([newCall, oldCall]))),
  );
  const buttons = screen.container.querySelectorAll<HTMLButtonElement>("[aria-expanded]");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]?.textContent).toContain("3:10Ended");
  await userEvent.click(buttons[0]!);
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  expect(screen.container.textContent).not.toContain("second-call: actual received speech");
  await userEvent.click(buttons[1]!);
  await expect.element(screen.getByText("second-call: actual received speech")).toBeVisible();
  await screen.unmount();

  // A fresh registry has no mounted query state; the server's history remains available.
  using reloaded = setup();
  reloaded.registry.set(reloaded.head, AsyncResult.success(history([newCall, oldCall])));
  await using afterReload = await render(reloaded.ui());
  const restored = afterReload.container.querySelectorAll<HTMLButtonElement>("[aria-expanded]");
  expect(restored).toHaveLength(2);
  await userEvent.click(restored[0]!);
  await expect.element(afterReload.getByText("first-call: actual received speech")).toBeVisible();
  expect(queries.transcript).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId, leaseId: "first-call" }),
    }),
  );
});

it("loads earlier calls above recent calls and supports keyboard expansion", async () => {
  using fixture = setup();
  fixture.registry.set(
    fixture.head,
    AsyncResult.success({ ...history([newCall]), nextBefore: "21" }),
  );
  await using screen = await render(fixture.ui());
  await userEvent.click(screen.getByRole("button", { name: "Earlier voice calls" }));
  const buttons = screen.container.querySelectorAll<HTMLButtonElement>("[aria-expanded]");
  expect(buttons).toHaveLength(2);
  await act(() => buttons[0]!.focus());
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  await userEvent.keyboard("{Enter}");
  expect(buttons[0]!.getAttribute("aria-expanded")).toBe("false");
  expect(queries.earlier).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, before: "21" },
  });
});

it("hides retained content when authorization fails and shows storage loss honestly", async () => {
  using fixture = setup();
  fixture.registry.set(
    fixture.head,
    AsyncResult.success({ ...history([oldCall]), persistenceAvailable: false }),
  );
  await using screen = await render(fixture.ui());
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Voice call history could not be saved completely.");
  await act(() =>
    fixture.registry.set(
      fixture.head,
      AsyncResult.failure(Cause.fail({ _tag: "EnvironmentScopeRequiredError" })),
    ),
  );
  await expect
    .element(screen.getByText("Voice call history is unavailable.", { exact: true }))
    .toBeVisible();
  expect(screen.container.querySelectorAll("[aria-expanded]")).toHaveLength(0);
});

it("keeps newly loaded calls visible at the end and preserves intentional scrollback", async () => {
  using fixture = setup();
  await using screen = await render(
    <div className="messages-timeline-scroll" style={{ height: 180, overflowY: "auto" }}>
      {fixture.ui()}
    </div>,
  );
  const scroll = screen.container.querySelector<HTMLElement>(".messages-timeline-scroll")!;
  const calls = Array.from({ length: 20 }, (_, index) => call(`call-${index}`, oldCall.startedAt));
  await act(() => fixture.registry.set(fixture.head, AsyncResult.success(history(calls))));
  await vi.waitFor(() =>
    expect(scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop).toBeLessThan(2),
  );
  await act(() => {
    scroll.scrollTop = 0;
    scroll.dispatchEvent(new Event("scroll"));
  });
  await act(() =>
    fixture.registry.set(fixture.head, AsyncResult.success(history([newCall, ...calls]))),
  );
  await vi.waitFor(() => expect(scroll.querySelectorAll("[aria-expanded]")).toHaveLength(21));
  expect(scroll.scrollTop).toBe(0);
});

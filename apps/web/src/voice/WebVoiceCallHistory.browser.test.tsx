import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProviderInstanceId,
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
import { VoiceConversationProvider, useVoiceConversationPresentation } from "./VoiceConversation";

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
                occurredAt:
                  input.leaseId === "second-call"
                    ? "2026-10-23T18:02:01.000Z"
                    : "2026-10-23T18:00:01.000Z",
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
    transcripts,
    ui: () => (
      <RegistryContext.Provider value={registry}>
        <WebVoiceCallHistory environmentId={environmentId} threadId={threadId} />
      </RegistryContext.Provider>
    ),
    [Symbol.dispose]: () => registry.dispose(),
  };
}

it("renders received speech directly across ended calls and reload, without opening a card", async () => {
  using fixture = setup();
  fixture.registry.set(fixture.head, AsyncResult.success(history([newCall, oldCall])));
  await using screen = await render(fixture.ui());
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  await expect.element(screen.getByText("second-call: actual received speech")).toBeVisible();
  expect(screen.container.querySelectorAll("[aria-expanded]")).toHaveLength(0);
  expect(screen.container.querySelectorAll("article")).toHaveLength(2);
  expect(screen.container.textContent).toContain("Call ended");
  await screen.unmount();

  using reloaded = setup();
  reloaded.registry.set(reloaded.head, AsyncResult.success(history([newCall, oldCall])));
  await using afterReload = await render(reloaded.ui());
  await expect.element(afterReload.getByText("first-call: actual received speech")).toBeVisible();
  expect(queries.transcript).toHaveBeenCalledWith(
    expect.objectContaining({
      environmentId,
      input: expect.objectContaining({ threadId, leaseId: "first-call" }),
    }),
  );
});

it("loads earlier calls into chronological scrollback and retains them as the recent page changes", async () => {
  using fixture = setup();
  fixture.registry.set(
    fixture.head,
    AsyncResult.success({ ...history([newCall]), nextBefore: "21" }),
  );
  await using screen = await render(fixture.ui());
  await expect.element(screen.getByText("second-call: actual received speech")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Earlier voice calls" }));
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  expect(queries.earlier).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, before: "21" },
  });
  await act(() => fixture.registry.set(fixture.head, AsyncResult.success(history([newCall]))));
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  const articles = [...screen.container.querySelectorAll("article")];
  expect(articles.map((node) => node.textContent)).toEqual([
    expect.stringContaining("first-call: actual received speech"),
    expect.stringContaining("second-call: actual received speech"),
  ]);
});

it("hides retained content when authorization fails and shows storage loss honestly", async () => {
  using fixture = setup();
  fixture.registry.set(
    fixture.head,
    AsyncResult.success({ ...history([oldCall]), persistenceAvailable: false }),
  );
  await using screen = await render(fixture.ui());
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
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
  expect(screen.container.querySelectorAll("article")).toHaveLength(0);
});

it("updates a received segment in place rather than appending its revision", async () => {
  using fixture = setup();
  fixture.registry.set(fixture.head, AsyncResult.success(history([oldCall])));
  await using screen = await render(fixture.ui());
  await expect.element(screen.getByText("first-call: actual received speech")).toBeVisible();
  const original = screen.container.querySelector("article");
  const atom = fixture.transcripts.get("first-call")!;
  const saved = fixture.registry.get(atom);
  if (!AsyncResult.isSuccess(saved)) throw new Error("fixture transcript not ready");
  await act(() =>
    fixture.registry.set(
      atom,
      AsyncResult.success({
        ...saved.value,
        entries: saved.value.entries.map((entry) => ({
          ...entry,
          text: "Corrected received speech",
          updatedAt: "2026-10-23T18:00:04.000Z",
        })),
      }),
    ),
  );
  await expect.element(screen.getByText("Corrected received speech")).toBeVisible();
  expect(screen.container.querySelector("article")).toBe(original);
  expect(screen.container.querySelectorAll("article")).toHaveLength(1);
  expect(screen.container.textContent).not.toContain("first-call: actual received speech");
});

it("shows a live segment immediately, revises it, and merges its persisted copy once", async () => {
  using fixture = setup();
  function LiveFeed({ text, final }: { text: string; final: boolean }) {
    useVoiceConversationPresentation({
      phase: "live",
      localMuted: false,
      outputMuted: false,
      error: null,
      sessionStatus: "active",
      lease: {
        leaseId: oldCall.leaseId,
        generation: 1,
        threadId,
        environmentId,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: null,
        plannerNativeThreadId: null,
        status: "active",
      },
      transcript: [{ segmentId: "segment", speaker: "user", text, final }],
    });
    return fixture.ui();
  }
  const draw = (text: string, final: boolean) => (
    <VoiceConversationProvider>
      <LiveFeed text={text} final={final} />
    </VoiceConversationProvider>
  );
  await using screen = await render(draw("first-call: actual", false));
  await expect.element(screen.getByText("first-call: actual", { exact: true })).toBeVisible();
  const original = screen.container.querySelector("article");
  await screen.rerender(draw("first-call: actual received speech", true));
  await expect
    .element(screen.getByText("first-call: actual received speech", { exact: true }))
    .toBeVisible();
  expect(screen.container.querySelector("article")).toBe(original);
  await act(() => fixture.registry.set(fixture.head, AsyncResult.success(history([oldCall]))));
  await expect.element(screen.getByText("Call ended", { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("article")).toHaveLength(1);
});

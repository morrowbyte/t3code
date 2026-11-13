import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import { useSyncExternalStore } from "react";
import { environmentCatalog } from "../../connection/catalog";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";

interface ReplyThreadSnapshot {
  readonly found: boolean;
  readonly hasMoreHistory: boolean;
  readonly loadFailed?: boolean;
}

type ReplyHistoryOutcome = Awaited<ReturnType<typeof loadReplyHistory>>;
interface ReplyTarget extends ScopedThreadRef {
  readonly key: string;
  readonly messageId: string;
}

export function replyMessageFromLocation(
  href: string,
  thread: { readonly environmentId: string; readonly threadId: string },
): string | null {
  try {
    const url = new URL(href, "http://t3.local");
    const parts = url.pathname.split("/");
    if (
      parts.length !== 3 ||
      decodeURIComponent(parts[1]!) !== thread.environmentId ||
      decodeURIComponent(parts[2]!) !== thread.threadId
    ) {
      return null;
    }
    return url.searchParams.get("messageId")?.trim() || null;
  } catch {
    return null;
  }
}

export async function loadReplyHistory(input: {
  readonly signal: AbortSignal;
  readonly readThread: () => Promise<ReplyThreadSnapshot | null>;
  readonly loadThrough: () => Promise<{ readonly _tag: "loaded" | "busy" | "noop" | "error" }>;
}): Promise<"found" | "unavailable" | "failed" | "aborted"> {
  for (let attempts = 0; ; attempts += 1) {
    const thread = await input.readThread();
    if (thread === null || input.signal.aborted) return "aborted";
    if (thread.loadFailed) return "failed";
    if (thread.found) return "found";
    if (!thread.hasMoreHistory) return "unavailable";
    if (attempts >= 20) return "failed";
    const result = await input.loadThrough();
    if (input.signal.aborted) return "aborted";
    if (result._tag === "error") return "failed";
    if (result._tag === "noop") return "unavailable";
  }
}

type ThreadDetail<K extends keyof typeof environmentThreadDetails> = Atom.Type<
  ReturnType<(typeof environmentThreadDetails)[K]>
>;

export function replyThreadSnapshot(input: {
  readonly thread: ThreadDetail<"quietThreadAtom">;
  readonly history: ThreadDetail<"historyAtom">;
  readonly status: ThreadDetail<"statusAtom">;
  readonly error: ThreadDetail<"errorAtom">;
  readonly unreachable?: boolean;
  readonly threadId: string;
  readonly messageId: string;
}): ReplyThreadSnapshot | null {
  if (input.status === "deleted") return { found: false, hasMoreHistory: false };
  const found =
    input.thread?.projection.visibleTurnItems.some(
      (row) =>
        row.sourceThreadId === input.threadId &&
        (row.item.type === "user_message" || row.item.type === "assistant_message") &&
        row.item.messageId === input.messageId,
    ) ?? false;
  if (found && !input.history.loading) {
    return { found: true, hasMoreHistory: input.history.hasMoreHistory };
  }
  if (input.unreachable || input.error !== null || input.history.error !== null) {
    return { found: false, hasMoreHistory: false, loadFailed: true };
  }
  if (input.history.loading || input.thread === null) return null;
  return { found: false, hasMoreHistory: input.history.hasMoreHistory };
}

function waitForReplyThread(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<ReplyThreadSnapshot | null>,
  signal: AbortSignal,
): Promise<ReplyThreadSnapshot | null> {
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = (value: ReplyThreadSnapshot | null) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(null);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);
    unsubscribe = registry.subscribe(atom, (value) => {
      if (value !== null) finish(value);
    });
    if (settled) unsubscribe();
    else {
      const value = registry.get(atom);
      if (value !== null) finish(value);
    }
  });
}

const replyHistoryAtom = Atom.family((target: ReplyTarget) => {
  const snapshot = Atom.make((get) => {
    const connectionResult = get(environmentCatalog.stateAtom(target.environmentId));
    const connection = AsyncResult.getOrElse(connectionResult, () => null);
    return replyThreadSnapshot({
      thread: get(environmentThreadDetails.quietThreadAtom(target)),
      history: get(environmentThreadDetails.historyAtom(target)),
      status: get(environmentThreadDetails.statusAtom(target)),
      error: get(environmentThreadDetails.errorAtom(target)),
      unreachable:
        AsyncResult.isFailure(connectionResult) ||
        connection?.phase === "offline" ||
        connection?.phase === "blocked" ||
        connection?.phase === "backoff",
      threadId: target.threadId,
      messageId: target.messageId,
    });
  });
  return Atom.make((get): ReplyHistoryOutcome | "loading" => {
    const controller = new AbortController();
    get.addFinalizer(() => controller.abort());
    const settle = (outcome: ReplyHistoryOutcome) => {
      if (controller.signal.aborted || outcome === "aborted") return;
      if (outcome === "failed") reportReplyNavigationFailure();
      if (outcome === "unavailable") {
        toastManager.add({
          type: "warning",
          title: "Originalnachricht nicht verfügbar",
          description:
            "Die Nachricht oder ihr Thread ist nicht mehr erreichbar. Die gespeicherte Replybeziehung bleibt unverändert.",
        });
      }
      get.setSelf(outcome);
    };
    void loadReplyHistory({
      signal: controller.signal,
      readThread: () => waitForReplyThread(get.registry, snapshot, controller.signal),
      loadThrough: async () => {
        const result = await runAtomCommand(
          get.registry,
          threadEnvironment.loadEarlierHistory,
          {
            environmentId: target.environmentId,
            input: { threadId: target.threadId, throughEntryId: target.messageId },
          },
          { label: "load original reply message", reportFailure: false },
        );
        return result._tag === "Success" ? result.value : { _tag: "error" };
      },
    })
      .then(settle)
      .catch(() => settle("failed"));
    return "loading";
  }).pipe(Atom.withLabel(`agent-reply:history:${target.key}`));
});

export function reportReplyNavigationFailure() {
  toastManager.add({
    type: "warning",
    title: "Originalnachricht konnte nicht geöffnet werden",
    description:
      "Die Umgebung ist möglicherweise offline. Öffne den Reply-Link erneut, um es noch einmal zu versuchen.",
  });
}

const NO_REPLY_HISTORY = Atom.make<ReplyHistoryOutcome | "loading">("loading");

export function useAgentReplyNavigation(thread: ScopedThreadRef | null) {
  const router = useRouter({ warn: false });
  const location = useSyncExternalStore(
    (notify: () => void) => router?.subscribe("onResolved", notify) ?? (() => {}),
    () => router?.state.location ?? null,
  );
  const href = location?.href ?? "";
  const locationKey = location?.state.__TSR_key;
  const messageId = thread ? replyMessageFromLocation(href, thread) : null;
  const target = thread && messageId ? { ...thread, messageId, key: locationKey ?? href } : null;
  const history = useAtomValue(target ? replyHistoryAtom(target) : NO_REPLY_HISTORY);
  return target ? { ...target, history } : null;
}

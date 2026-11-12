import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "./assistantCitationNavigation";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "first line\n\tsecond line (with a #hash & spaces) 🚀",
  start: 12,
  end: 59,
  prefix: "Before:\n",
  suffix: "\nAfter.",
};

function createCitationRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("assistant citation navigation", () => {
  it.each(["same", "other-thread", "other-environment"])(
    "preserves quote navigation and marks only a thread return (%s)",
    async (source) => {
      const router = createCitationRouter();
      const origin = scopeThreadRef(
        source === "other-environment"
          ? EnvironmentId.make("environment-two")
          : citation.environmentId,
        source === "other-thread" ? ThreadId.make("thread-two") : citation.threadId,
      );
      await router.navigate(assistantCitationNavigation(citation, origin));
      expect(router.state.location.state.threadLinkOrigin).toBe(source !== "same");

      expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
      let href = router.history.location.href;
      for (let reload = 0; reload < 3; reload++) {
        const reloaded = createCitationRouter(href);
        await reloaded.load();
        await reloaded.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: citation.environmentId, threadId: citation.threadId },
          hash: true,
          replace: true,
        });
        href = reloaded.history.location.href;
        expect(assistantCitationFromLocation(href)).toEqual(citation);
      }
    },
  );

  it("returns directly to the source thread after quoting inside a linked thread", async () => {
    const router = createCitationRouter("/environment-one/source-thread");
    await router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: citation.environmentId, threadId: citation.threadId },
      state: { threadLinkOrigin: true },
    });
    await router.navigate(
      assistantCitationNavigation(
        citation,
        scopeThreadRef(citation.environmentId, citation.threadId),
        true,
      ),
    );
    expect(router.state.location.state.threadLinkOrigin).toBe(true);
    expect(router.history.length).toBe(2);
    router.history.back();
    await router.load();
    expect(router.state.location.pathname).toBe("/environment-one/source-thread");
  });

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createCitationRouter();
    await router.navigate(assistantCitationNavigation(citation));
    const previous = router.state.location;
    await router.navigate(assistantCitationNavigation(citation));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
  });
});

import type { ThreadFeedEntry } from "../../lib/threadActivity";

export function conversationResultFeed(feed: ReadonlyArray<ThreadFeedEntry>) {
  return feed.filter((entry) => entry.type !== "message" || entry.message.role === "assistant");
}

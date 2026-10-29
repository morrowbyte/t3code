import type { LiveVoiceActivity } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { LIVE_VOICE_ACTIVITY_LIMIT, retainLiveVoiceActivity } from "./liveVoiceActivity.ts";

const at = "2026-10-28T20:00:00.000Z";
function activity(
  id: string,
  revision = 1,
  status: LiveVoiceActivity["status"] = "started",
): LiveVoiceActivity {
  return { id, revision, status, action: "read-work", occurredAt: at, updatedAt: at };
}

it("reconciles replayed activity revisions in place and retains brief terminal states", () => {
  const started = retainLiveVoiceActivity([], activity("call"));
  const running = retainLiveVoiceActivity(started, activity("call", 2, "running"));
  const completed = retainLiveVoiceActivity(running, {
    ...activity("call", 3, "completed"),
    occurredAt: "later",
    updatedAt: "later",
  });
  expect(completed).toEqual([{ ...activity("call", 3, "completed"), updatedAt: "later" }]);
  expect(retainLiveVoiceActivity(completed, activity("call", 2, "running"))).toBe(completed);
  expect(retainLiveVoiceActivity(completed, activity("call", 4, "waiting"))).toBe(completed);
  expect(retainLiveVoiceActivity(completed, activity("call", 3, "completed"))).toBe(completed);
  expect(retainLiveVoiceActivity(completed, activity("next"))).toHaveLength(2);
});

it("bounds history, prefers evicting older completed calls, and always retains the newest receipt", () => {
  let entries: ReadonlyArray<LiveVoiceActivity> = [activity("held", 2, "waiting")];
  for (let index = 0; index < LIVE_VOICE_ACTIVITY_LIMIT + 3; index++)
    entries = retainLiveVoiceActivity(entries, activity(`done-${index}`, 3, "completed"));
  expect(entries).toHaveLength(LIVE_VOICE_ACTIVITY_LIMIT);
  expect(entries[0]!.id).toBe("held");
  expect(entries.at(-1)!.id).toBe(`done-${LIVE_VOICE_ACTIVITY_LIMIT + 2}`);
  let allRunning: ReadonlyArray<LiveVoiceActivity> = [];
  for (let index = 0; index < LIVE_VOICE_ACTIVITY_LIMIT; index++)
    allRunning = retainLiveVoiceActivity(allRunning, activity(`running-${index}`, 2, "running"));
  const withReceipt = retainLiveVoiceActivity(allRunning, activity("short", 3, "completed"));
  expect(withReceipt).toHaveLength(LIVE_VOICE_ACTIVITY_LIMIT);
  expect(withReceipt.at(-1)!.id).toBe("short");
});

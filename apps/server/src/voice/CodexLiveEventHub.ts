import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { LiveVoiceActivity, LiveVoiceEvent, LiveVoiceSession } from "@t3tools/contracts";
import {
  liveVoiceActivityIsTerminal,
  retainLiveVoiceActivity,
} from "@t3tools/shared/liveVoiceActivity";
import * as LiveVoiceHistory from "./LiveVoiceHistory.ts";

type LeaseKey = `${string}:${number}`;
const keyOf = (leaseId: string, generation: number): LeaseKey => `${leaseId}:${generation}`;

/** Ordered per-environment Live events. A stream's first item is its status barrier. */
export class CodexLiveEventHub extends Context.Service<
  CodexLiveEventHub,
  {
    readonly register: (session: LiveVoiceSession) => Effect.Effect<void>;
    readonly publish: (event: LiveVoiceEvent) => Effect.Effect<void>;
    readonly subscribe: (input: {
      readonly leaseId: string;
      readonly generation: number;
    }) => Stream.Stream<LiveVoiceEvent>;
  }
>()("t3/voice/CodexLiveEventHub") {}

export const make = Effect.gen(function* () {
  const history = yield* LiveVoiceHistory.LiveVoiceHistory;
  const lock = yield* Semaphore.make(1);
  const sessions = yield* Ref.make(new Map<LeaseKey, LiveVoiceSession>());
  const events = yield* PubSub.unbounded<LiveVoiceEvent>();
  const activities = new Map<LeaseKey, ReadonlyArray<LiveVoiceActivity>>();

  const publish = Effect.fn("CodexLiveEventHub.publish")((event: LiveVoiceEvent) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const identity = event.type === "status" ? event.session : event;
        const session =
          event.type === "status"
            ? event.session
            : (yield* Ref.get(sessions)).get(keyOf(identity.leaseId, identity.generation));
        const key = keyOf(identity.leaseId, identity.generation);
        if (event.type === "activity") {
          if (
            !session ||
            event.environmentId !== session.environmentId ||
            event.threadId !== session.threadId ||
            !["starting", "active", "stopping"].includes(session.status)
          )
            return;
          const previous = activities.get(key) ?? [];
          const next = retainLiveVoiceActivity(previous, event.activity);
          if (next === previous) return;
          activities.set(key, next);
          yield* PubSub.publish(events, {
            ...event,
            activity: next.find((activity) => activity.id === event.activity.id)!,
          });
          return;
        }
        if (session && (event.type === "status" || event.type === "transcript")) {
          yield* history.record(session, event);
        }
        if (event.type === "status") {
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current);
            next.set(keyOf(event.session.leaseId, event.session.generation), event.session);
            return next;
          });
          if (["closed", "failed", "unknown"].includes(event.session.status)) {
            const updatedAt = DateTime.formatIso(yield* DateTime.now);
            for (const activity of activities.get(key) ?? []) {
              if (liveVoiceActivityIsTerminal(activity)) continue;
              yield* PubSub.publish(events, {
                type: "activity",
                leaseId: event.session.leaseId,
                generation: event.session.generation,
                environmentId: event.session.environmentId,
                threadId: event.session.threadId,
                activity: {
                  ...activity,
                  revision: activity.revision + 1,
                  status: "interrupted",
                  updatedAt,
                },
              });
            }
            activities.delete(key);
          }
        }
        yield* PubSub.publish(events, event);
      }),
    ),
  );

  return CodexLiveEventHub.of({
    register: Effect.fn("CodexLiveEventHub.register")((session) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          if (current.has(keyOf(session.leaseId, session.generation))) return;
          yield* history.record(session, { type: "status", session });
          const next = new Map(current);
          next.set(keyOf(session.leaseId, session.generation), session);
          yield* Ref.set(sessions, next);
        }),
      ),
    ),
    publish,
    subscribe: ({ leaseId, generation }) =>
      Stream.unwrap(
        lock.withPermits(1)(
          Effect.gen(function* () {
            // Install the queue before taking the snapshot. The same lock orders any
            // later publication after this initial event in the returned stream.
            const subscription = yield* PubSub.subscribe(events);
            const session = (yield* Ref.get(sessions)).get(keyOf(leaseId, generation));
            if (session === undefined) return Stream.empty;
            const initial: LiveVoiceEvent = { type: "status", session };
            const snapshot = Stream.fromIterable(
              (activities.get(keyOf(leaseId, generation)) ?? []).map(
                (activity): LiveVoiceEvent => ({
                  type: "activity",
                  leaseId: session.leaseId,
                  generation: session.generation,
                  environmentId: session.environmentId,
                  threadId: session.threadId,
                  activity,
                }),
              ),
            );
            return Stream.concat(
              Stream.concat(Stream.succeed(initial), snapshot),
              Stream.fromSubscription(subscription).pipe(
                Stream.filter((event) =>
                  event.type === "status"
                    ? event.session.leaseId === leaseId && event.session.generation === generation
                    : event.leaseId === leaseId && event.generation === generation,
                ),
              ),
            );
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(CodexLiveEventHub, make).pipe(
  Layer.provide(LiveVoiceHistory.layer),
);

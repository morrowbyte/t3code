import type {
  LiveVoiceEvent,
  VoiceIntakeDecision,
  VoiceIntakeIntent,
  VoiceIntakeProvenance,
  VoiceIntakeSnapshot,
  VoiceIntakeSource,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export interface VoiceIntakeDependencies {
  readonly leaseId: string;
  readonly generation: number;
  readonly provisionalAllowed?: boolean;
  readonly defaultProjectId?: string;
  readonly projects?: VoiceIntakeSnapshot["projects"];
  readonly restored?: ReadonlyArray<VoiceIntakeIntent>;
  readonly getPreviewContext?: () => string | null;
  readonly current: Effect.Effect<boolean>;
  readonly stopId: Effect.Effect<string | null | undefined>;
  readonly decide: (snapshot: VoiceIntakeSnapshot) => Effect.Effect<VoiceIntakeDecision, Error>;
  readonly admit: (
    source: VoiceIntakeProvenance,
    request: string,
    projectId?: string,
    previewContext?: string | null,
  ) => Effect.Effect<VoiceIntakeIntent, Error>;
  readonly read: (intent: VoiceIntakeIntent) => Effect.Effect<VoiceIntakeIntent, Error>;
  readonly steer: (
    intent: VoiceIntakeIntent,
    message: string,
    requestId: string,
    readOnly: boolean,
    previewContext?: string | null,
  ) => Effect.Effect<VoiceIntakeIntent, Error>;
  readonly confirm: (intent: VoiceIntakeIntent) => Effect.Effect<void, Error>;
  readonly store: (intent: VoiceIntakeIntent) => Effect.Effect<void, Error>;
}

// A conservative revocation fence, never an intent detector. Work admission
// always requires the semantic model. Whole words also catch split ASR tokens.
const retractionWords = new Set([
  "no",
  "not",
  "never",
  "don't",
  "dont",
  "cannot",
  "can't",
  "cancel",
  "stop",
  "wait",
  "actually",
  "instead",
  "correction",
  "scratch",
  "nein",
  "nicht",
  "nie",
  "kein",
  "keine",
  "keinen",
  "keiner",
  "keinem",
  "keines",
  "stopp",
  "warte",
  "abbrechen",
  "abbruch",
  "korrigiere",
  "korrigieren",
  "korrektur",
  "statt",
  "stattdessen",
  "sondern",
  "vergiss",
]);
const retractions = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{M}]+(?:['’][\p{L}]+)*/gu) ?? []).filter((word) =>
    retractionWords.has(word.replaceAll("’", "'")),
  ).length;

export function makeVoiceIntake(input: VoiceIntakeDependencies) {
  const segments = new Map<string, VoiceIntakeSnapshot["segments"][number]>();
  const intents = new Map((input.restored ?? []).map((intent) => [intent.id, intent]));
  let version = 0;
  let enabled = true;
  let reason: string | null = null;
  let running = false;
  let decidedVersion = 0;
  let decisions = 0;
  let noticeVersion = 0;
  let retractionEpoch = 0;
  const sourceEpochs = new WeakMap<VoiceIntakeSource, number>();
  const corrections = new Map<string, number>();
  const segmentStops = new Map<string, string | null | undefined>();
  const gaps = new Set<string>();
  const parts = new Map<string, { revision: number; count: number; chunks: Map<number, string> }>();
  const isActive = (status: string) =>
    ["preparing", "starting", "running", "waiting", "queued"].includes(status);
  const isSteerable = (status: string) => ["starting", "running", "waiting"].includes(status);
  const observe = (event: LiveVoiceEvent, stopId?: string | null) =>
    Effect.sync(() => {
      const identity = event.type === "status" ? event.session : event;
      if (identity.leaseId !== input.leaseId || identity.generation !== input.generation) return;
      if (
        event.type === "status" &&
        ["stopping", "closed", "failed", "unknown"].includes(event.session.status)
      ) {
        enabled = false;
        reason = "lease_ended";
        return;
      }
      if (!enabled || event.type !== "transcript" || event.role !== "user" || !event.segment)
        return;
      const source = event.segment;
      const previous = segments.get(source.id);
      if (!segmentStops.has(source.id)) {
        if (segmentStops.size >= 256) {
          reason = "intake_capacity";
          return;
        }
        segmentStops.set(source.id, stopId);
      }
      const capturedStopId = segmentStops.get(source.id);
      if (capturedStopId === undefined) {
        reason = "source_stop_unavailable";
        version += 1;
        noticeVersion = version;
        return;
      }
      if (previous && (source.revision <= previous.revision || (previous.final && !source.final)))
        return;
      if (
        source.kind === "delta" &&
        (previous?.final || source.revision !== (previous?.revision ?? 0) + 1)
      ) {
        gaps.add(source.id);
        reason = "transcript_gap";
        return;
      }
      let pending = parts.get(source.id);
      if (pending && pending.revision > source.revision) return;
      if (!pending || pending.revision < source.revision) {
        pending = { revision: source.revision, count: source.partCount, chunks: new Map() };
        parts.set(source.id, pending);
      }
      if (pending.count !== source.partCount || pending.chunks.has(source.partIndex)) return;
      pending.chunks.set(source.partIndex, event.text);
      if (pending.chunks.size !== pending.count) return;
      const text = Array.from({ length: pending.count }, (_, index) =>
        pending.chunks.get(index)!,
      ).join("");
      parts.delete(source.id);
      if (source.kind === "snapshot") gaps.delete(source.id);
      const nextText = source.kind === "snapshot" ? text : (previous?.text ?? "") + text;
      if (
        (previous && !nextText.startsWith(previous.text)) ||
        retractions(nextText) > retractions(previous?.text ?? "")
      )
        retractionEpoch += 1;
      if (previous && !nextText.startsWith(previous.text))
        corrections.set(source.id, source.revision);
      segments.delete(source.id);
      segments.set(source.id, {
        id: source.id,
        revision: source.revision,
        final: source.final,
        // A late final cannot turn a pre-Stop segment into fresh authorization.
        stopId: capturedStopId,
        text: nextText,
      });
      version += 1;
      let size = [...segments.values()].reduce((size, segment) => size + segment.text.length, 0);
      while (segments.size > 24 || size > 16_000) {
        const removable = [...segments.values()].find(
          (segment) =>
            segment.final &&
            ![...intents.values()].some(
              (intent) =>
                (intent.provisional &&
                  isActive(intent.status) &&
                  intent.sources.some((source) => source.segmentId === segment.id)) ||
                intent.pendingSteer?.sources.some((source) => source.segmentId === segment.id),
            ),
        );
        if (!removable) break;
        segments.delete(removable.id);
        size -= removable.text.length;
      }
    });
  const overlap = (left: VoiceIntakeSource, right: VoiceIntakeSource) =>
    left.segmentId === right.segmentId && left.start < right.end && right.start < left.end;
  const currentSources = (sources: ReadonlyArray<VoiceIntakeSource>) =>
    sources.every((source) => {
      const current = segments.get(source.segmentId);
      return (
        current !== undefined &&
        sourceEpochs.get(source) === retractionEpoch &&
        source.start < source.end &&
        current.text.slice(source.start, source.end) === source.quote
      );
    });
  const persist = Effect.fn("VoiceIntake.persist")(function* (intent: VoiceIntakeIntent) {
    intents.set(intent.id, intent);
    yield* input.store(intent);
  });
  const apply = Effect.fn("VoiceIntake.apply")(function* () {
    if (!enabled || version === 0 || !(yield* input.current)) return;
    for (const intent of intents.values()) {
      let observed = yield* input.read(intent);
      const pending = observed.pendingSteer;
      const currentStopId = yield* input.stopId;
      if (pending) {
        const valid =
          pending.requestId.startsWith(`${input.leaseId}:${input.generation}:`) &&
          currentSources(pending.sources) &&
          pending.sources.every((source) => source.stopId === currentStopId) &&
          pending.sources.every(
            (source) => (corrections.get(source.segmentId) ?? 0) <= source.revision,
          );
        if (valid && isActive(observed.status)) {
          if (observed.provisional && !pending.readOnly) {
            yield* input.confirm({ ...observed, provisional: false, sources: pending.sources });
            observed = { ...observed, provisional: false };
            yield* persist(observed);
          }
          if (!isSteerable(observed.status)) {
            yield* persist(observed);
            continue;
          }
          observed = yield* input.steer(
            observed,
            pending.message,
            pending.requestId,
            pending.readOnly,
            pending.previewContext,
          );
          observed = {
            ...observed,
            startedProvisional: observed.startedProvisional && pending.readOnly,
          };
        } else {
          reason = valid ? "task_inactive" : "source_revised";
          noticeVersion = version;
        }
        yield* persist({ ...observed, pendingSteer: null });
        observed = { ...observed, pendingSteer: null };
      }
      intents.set(intent.id, observed);
    }
    if (version <= decidedVersion) return;
    if (
      gaps.size ||
      parts.size ||
      segments.size > 24 ||
      [...segments.values()].some((segment) => segment.text.length > 8_000) ||
      [...segments.values()].reduce((size, segment) => size + segment.text.length, 0) > 16_000
    ) {
      reason = "transcript_incomplete";
      return;
    }
    if (![...segments.values()].some((segment) => segment.text.trim())) return;
    const snapshot: VoiceIntakeSnapshot = {
      requestId: `${input.leaseId}:${input.generation}:intake:${version}`,
      previewContext: input.getPreviewContext?.() ?? null,
      leaseId: input.leaseId,
      generation: input.generation,
      version,
      provisionalReadOnlyAvailable: input.provisionalAllowed !== false,
      defaultProjectId: input.defaultProjectId ?? "current-project",
      projects: input.projects ?? [],
      segments: [...segments.values()].slice(-12),
      intents: [...intents.values()]
        .toSorted((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)))
        .slice(0, 24)
        .map((intent) => ({
          id: intent.id,
          provisional: intent.provisional,
          status: intent.status,
          request: intent.request.slice(0, 200),
          sources: intent.sources.map(({ segmentId, revision, start, end }) => ({
            segmentId,
            revision,
            start,
            end,
          })),
          result: intent.result?.slice(0, 300) ?? null,
        })),
    };
    decidedVersion = version;
    decisions += 1;
    const capturedEpoch = retractionEpoch;
    const decision = yield* input.decide(snapshot);
    if (!enabled || !(yield* input.current)) return;
    if (capturedEpoch !== retractionEpoch) {
      reason = "source_revised";
      return;
    }
    if (decision.requestId !== snapshot.requestId) {
      reason = "decision_mismatch";
      return;
    }
    for (const [index, action] of decision.actions.entries()) {
      if (!enabled || !(yield* input.current)) return;
      if (action.type === "opt_out") {
        if (version !== snapshot.version) {
          reason = "source_revised";
          continue;
        }
        enabled = false;
        reason = "opted_out";
        return;
      }
      if (action.type === "defer") {
        if (version !== snapshot.version) continue;
        reason = action.reason.slice(0, 1_000);
        noticeVersion = snapshot.version;
        continue;
      }
      if (action.type === "reference") {
        if (version !== snapshot.version) continue;
        const intent = intents.get(action.intentId);
        if (!intent) {
          reason = "intent_unknown";
          continue;
        }
        yield* persist(yield* input.read(intent));
        noticeVersion = snapshot.version;
        continue;
      }
      // The model copies an exact quote, but never calculates character offsets.
      // A unique match binds it to this revision without fuzzy text matching.
      const sources: VoiceIntakeSource[] = [];
      for (const anchor of action.sources) {
        const prior = snapshot.segments.find((segment) => segment.id === anchor.segmentId);
        const start = prior?.text.indexOf(anchor.quote) ?? -1;
        if (
          !prior ||
          anchor.revision !== prior.revision ||
          start < 0 ||
          prior.text.lastIndexOf(anchor.quote) !== start
        )
          break;
        const source = { ...anchor, stopId: prior.stopId, start, end: start + anchor.quote.length };
        sourceEpochs.set(source, capturedEpoch);
        sources.push(source);
      }
      const valid =
        sources.length === action.sources.length &&
        sources.every((source) => {
          const prior = snapshot.segments.find((segment) => segment.id === source.segmentId)!;
          return segments.get(source.segmentId)?.text.startsWith(prior.text);
        }) &&
        currentSources(sources);
      if (!valid) {
        noticeVersion = snapshot.version;
        reason = "source_revised";
        continue;
      }
      const currentStopId = yield* input.stopId;
      if (sources.some((source) => source.stopId !== currentStopId)) {
        reason = "source_stopped";
        noticeVersion = snapshot.version;
        continue;
      }
      const partial = sources.some(
        (source) => !snapshot.segments.find((segment) => segment.id === source.segmentId)!.final,
      );
      // ASR finality is not authorization. Only preliminary research needs the
      // provisional read-only policy; a complete authorized mutation starts now.
      const provisional = partial && action.type !== "confirm" && action.readOnly;
      if (provisional && input.provisionalAllowed === false) {
        reason = "provisional_unavailable";
        continue;
      }
      const owner = action.type !== "new" ? intents.get(action.intentId) : undefined;
      if (action.type !== "new" && owner === undefined) {
        noticeVersion = snapshot.version;
        reason = "intent_unknown";
        continue;
      }
      const foreign = [...intents.values()].some(
        (intent) =>
          intent.id !== owner?.id &&
          sources.some((source) =>
            intent.claimedSources.some((claimed) => overlap(source, claimed)),
          ),
      );
      if (foreign) {
        reason = "source_already_owned";
        continue;
      }
      if (action.type === "confirm") {
        if (!owner || partial) {
          reason = "awaiting_final_intent";
          continue;
        }
        const claimedSources = [
          ...owner.claimedSources,
          ...sources.filter(
            (source) => !owner.claimedSources.some((claimed) => overlap(source, claimed)),
          ),
        ];
        if (claimedSources.length > 128) {
          reason = "intake_capacity";
          continue;
        }
        const confirmed = { ...owner, provisional: false, sources, claimedSources };
        yield* input.confirm(confirmed);
        yield* persist(confirmed);
        noticeVersion = snapshot.version;
        reason = null;
      } else if (action.type === "new") {
        if (
          action.projectId !== null &&
          action.projectId !== snapshot.defaultProjectId &&
          !snapshot.projects.some((project) => project.id === action.projectId)
        ) {
          reason = "project_unknown";
          continue;
        }
        if (intents.size >= 128) {
          reason = "intake_capacity";
          continue;
        }
        const intent = yield* input.admit(
          {
            leaseId: input.leaseId,
            generation: input.generation,
            intentId: `${snapshot.requestId}:${index}`,
            stopId: sources[0]!.stopId,
            provisional,
            sources: sources,
          },
          action.request,
          action.projectId ?? undefined,
          snapshot.previewContext,
        );
        yield* persist(intent);
        noticeVersion = snapshot.version;
        reason = null;
      } else if (owner) {
        const current = yield* input.read(owner);
        if (!isActive(current.status)) {
          yield* persist(current);
          reason = "task_inactive";
          noticeVersion = snapshot.version;
          continue;
        }
        const fresh = sources.filter(
          (source) =>
            !current.claimedSources.some(
              (claimed) =>
                claimed.segmentId === source.segmentId &&
                claimed.start === source.start &&
                claimed.end === source.end &&
                claimed.quote === source.quote,
            ),
        );
        const confirmedContinuation =
          current.startedProvisional &&
          !current.provisional &&
          !action.readOnly &&
          sources.every((source) =>
            current.sources.some(
              (confirmed) =>
                confirmed.segmentId === source.segmentId &&
                confirmed.start === source.start &&
                confirmed.end === source.end &&
                confirmed.quote === source.quote,
            ),
          );
        if (!fresh.length && !confirmedContinuation && !(current.provisional && !action.readOnly)) {
          yield* persist(current);
          continue;
        }
        if (current.claimedSources.length + fresh.length > 128) {
          reason = "intake_capacity";
          continue;
        }
        const requestId = `${snapshot.requestId}:${index}`;
        let claimed = {
          ...current,
          pendingSteer: {
            requestId,
            message: action.message,
            readOnly: action.readOnly,
            sources,
            previewContext: snapshot.previewContext ?? null,
          },
          sources: [...current.sources, ...fresh].slice(-8),
          claimedSources: [...current.claimedSources, ...fresh],
        };
        yield* persist(claimed);
        // A complete explicit refinement can authorize the existing read-only
        // child before ASR final. The separate confirm action remains final-only.
        if (claimed.provisional && !action.readOnly) {
          yield* input.confirm({ ...claimed, provisional: false, sources });
          claimed = { ...claimed, provisional: false };
          yield* persist(claimed);
        }
        if (!isSteerable(claimed.status)) {
          reason = "awaiting_steerable_run";
          noticeVersion = snapshot.version;
          continue;
        }
        const steered = yield* input.steer(
          claimed,
          action.message,
          requestId,
          action.readOnly,
          snapshot.previewContext,
        );
        yield* persist({
          ...steered,
          startedProvisional: steered.startedProvisional && action.readOnly,
          pendingSteer: null,
          sources: claimed.sources,
          claimedSources: claimed.claimedSources,
        });
        noticeVersion = snapshot.version;
        reason = null;
      }
    }
  });
  const processLatest = Effect.fn("VoiceIntake.processLatest")(function* () {
    if (running || !enabled) return;
    running = true;
    yield* apply().pipe(
      Effect.ensuring(
        Effect.sync(() => {
          running = false;
        }),
      ),
    );
  });
  return {
    observe,
    processLatest,
    validateSources: Effect.fn("VoiceIntake.validateSources")(function* (
      sources: ReadonlyArray<VoiceIntakeSource>,
    ) {
      const stopId = yield* input.stopId;
      return (
        enabled &&
        currentSources(sources) &&
        sources.every(
          (source) =>
            source.stopId === stopId && (corrections.get(source.segmentId) ?? 0) <= source.revision,
        )
      );
    }),
    refused: Effect.sync(() => {
      reason = "decision_unavailable";
      noticeVersion = version;
    }),
    stop: Effect.sync(() => {
      enabled = false;
    }),
    state: Effect.sync(() => ({
      enabled,
      version,
      reason,
      decisions,
      noticeVersion,
      running,
      intents: [...intents.values()],
    })),
  };
}

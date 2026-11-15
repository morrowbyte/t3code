import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "../../packages/effect-codex-app-server/src/client.ts";
import { makeCodexVoiceIntakeDecider } from "../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2VoiceIntake.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Keep protocol counters and their private file record in one synchronous callback step.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeUtil from "node:util";
import * as NodeURL from "node:url";
import { caseForSample, cases, snapshotFor } from "./cases.ts";
import { grade } from "./grade.ts";
import { ProviderInstanceId } from "../../packages/contracts/src/providerInstance.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    binary: { type: "string" },
    "binary-sha256": { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    effort: { type: "string", default: "low,medium" },
    samples: { type: "string", default: "3" },
    case: { type: "string" },
    baseline: { type: "string" },
  },
});
if (!values.out || !values.binary || !values["binary-sha256"])
  throw new Error("--out, --binary and --binary-sha256 are required");
const samples = Number(values.samples);
const efforts = values.effort.split(",");
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 3 ||
  efforts.some((effort) => !["medium", "low"].includes(effort))
)
  throw new Error("Use 1–3 samples with medium and/or low");
const selectedCases = cases.filter((testCase) =>
  values.case ? values.case.split(",").includes(testCase.id) : !testCase.optIn,
);
if (!selectedCases.length || selectedCases.length * samples * efforts.length > 36)
  throw new Error("No cases selected or 36-turn bound exceeded");
const runtimeLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layerDigest,
  NodeCrypto.layerSecureRandom,
);
const runRuntime = <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof runtimeLayer>>) =>
  Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer)));
const { crypto, digest, path } = await runRuntime(
  Effect.all({ crypto: SecureRandom.SecureRandom, digest: Digest.Digest, path: Path.Path }),
);
const output = path.resolve(values.out);
const binary = path.resolve(values.binary);
const hash = Effect.fn("VoiceIntakeEval.hash")(function* (file: string) {
  return Buffer.from(yield* digest.digest(Digest.sha256, NodeFS.readFileSync(file))).toString(
    "hex",
  );
});
const binarySha256 = await runRuntime(hash(binary));
if (binarySha256 !== values["binary-sha256"]) throw new Error("Native binary digest mismatch");
NodeFS.mkdirSync(output, { recursive: true, mode: 0o700 });
if (NodeFS.existsSync(path.join(output, "manifest.json")))
  throw new Error("Refusing to overwrite an existing run");
const repository = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const sourceFiles = [
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2VoiceIntake.ts",
  "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2VoiceIsolation.ts",
  "packages/contracts/src/voiceIntake.ts",
  "evals/voice-intake/cases.ts",
  "evals/voice-intake/grade.ts",
  "evals/voice-intake/run.ts",
];
const sourceDigests = Effect.fn("VoiceIntakeEval.sourceDigests")(() =>
  Effect.forEach(sourceFiles, (file) =>
    hash(path.join(repository, file)).pipe(Effect.map((digest) => [file, digest] as const)),
  ).pipe(Effect.map(Object.fromEntries)),
);
const Json = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeEffect(Json);
const write = (name: string, value: unknown) =>
  NodeFS.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
const append = (name: string, value: unknown) =>
  NodeFS.appendFileSync(path.join(output, name), JSON.stringify(value) + "\n", { mode: 0o600 });
const startedAt = await runRuntime(DateTime.now);
const manifest = {
  version: 1,
  owner: "voice-interactivity-20261101-native-qualification",
  createdAt: DateTime.formatIso(startedAt),
  expiresAt: DateTime.formatIso(DateTime.addDuration(startedAt, "7 days")),
  output,
  binary,
  binarySha256,
  model: values.model,
  serviceTier: "priority",
  efforts,
  samples,
  sampleIdentity:
    "fresh segment and intent IDs per decision, including intent provenance and expected targets",
  sourceDigests: await runRuntime(sourceDigests()),
  actualWorkDispatched: false,
  audioMeasured: false,
  privateSyntheticDataOnly: true,
  baseline: values.baseline ?? null,
};
write("manifest.json", manifest);

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
const sanitize = (value: unknown) =>
  typeof value === "string"
    ? value
        .replace(/https?:\/\/\S+|Bearer\s+\S+|\bsk-\S+|\beyJ[A-Za-z0-9_.-]+/g, "[redacted]")
        .slice(0, 600)
    : undefined;
const totals = {
  processes: 0,
  initialize: 0,
  threadStarts: 0,
  turnStarts: 0,
  turnCompleted: 0,
  serverRequests: 0,
  decodeFailures: 0,
  nativeErrors: 0,
  toolItems: 0,
  concurrentTurnsMax: 0,
  cwdRemoved: 0,
};
const rows: Array<Record<string, unknown>> = [];
const ownedPids: number[] = [];
let failure: Record<string, unknown> | null = null;

const program = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const protocolFailure = yield* Deferred.make<never, Error>();
    for (const effort of efforts) {
      const leaseId = `synthetic-intake-${effort}-${yield* crypto.uuidV4()}`;
      let opened = false;
      let version = 0;
      let activeTurns = 0;
      const modelSelection = {
        instanceId: ProviderInstanceId.make("codex"),
        model: values.model,
        options: [
          { id: "reasoningEffort", value: effort },
          { id: "serviceTier", value: "priority" },
        ],
      };
      const decider = yield* makeCodexVoiceIntakeDecider(`${leaseId}:1`, () =>
        Effect.gen(function* () {
          const cwd = NodeFS.mkdtempSync(path.join(NodeOS.tmpdir(), "t3-voice-intake-eval-"));
          NodeFS.chmodSync(cwd, 0o700);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              NodeFS.rmSync(cwd, { recursive: true, force: true });
              totals.cwdRemoved++;
            }),
          );
          const handle = yield* spawner.spawn(
            ChildProcess.make(binary, ["app-server"], { cwd, forceKillAfter: "1 second" }),
          );
          totals.processes++;
          ownedPids.push(Number(handle.pid));
          const requests = new Map<string | number, string>();
          const context = yield* Layer.build(
            CodexClient.layerChildProcess(handle, {
              logIncoming: true,
              logOutgoing: true,
              logger: (event) =>
                Effect.sync(() => {
                  if (event.stage === "raw") return;
                  const payload = record(event.payload);
                  const method = typeof payload.method === "string" ? payload.method : null;
                  const id =
                    typeof payload.id === "string" || typeof payload.id === "number"
                      ? payload.id
                      : undefined;
                  const item = record(record(payload.params).item);
                  if (event.stage === "decode_failed") totals.decodeFailures++;
                  if (event.direction === "incoming" && (method === "error" || payload.error))
                    totals.nativeErrors++;
                  if (event.direction === "outgoing" && method) {
                    if (id !== undefined) requests.set(id, method);
                    if (method === "initialize") totals.initialize++;
                    if (method === "thread/start") totals.threadStarts++;
                    if (method === "turn/start") {
                      totals.turnStarts++;
                      activeTurns++;
                      totals.concurrentTurnsMax = Math.max(totals.concurrentTurnsMax, activeTurns);
                    }
                  }
                  if (event.direction === "incoming" && method && id !== undefined)
                    totals.serverRequests++;
                  if (event.direction === "incoming" && method === "turn/completed") {
                    totals.turnCompleted++;
                    activeTurns--;
                  }
                  if (
                    event.direction === "incoming" &&
                    method === "item/completed" &&
                    !["userMessage", "reasoning", "agentMessage"].includes(String(item.type))
                  )
                    totals.toolItems++;
                  const responseTo =
                    event.direction === "incoming" && id !== undefined
                      ? requests.get(id)
                      : undefined;
                  let observation: Record<string, unknown> | undefined;
                  if (responseTo === "thread/start") {
                    const result = record(payload.result);
                    const sandbox = record(result.sandbox);
                    const thread = record(result.thread);
                    observation = {
                      model: result.model,
                      reasoningEffort: result.reasoningEffort,
                      serviceTier: result.serviceTier,
                      approvalPolicy: result.approvalPolicy,
                      sandboxType: sandbox.type,
                      networkAccess: sandbox.networkAccess,
                      workspaceRoots: Array.isArray(result.runtimeWorkspaceRoots)
                        ? result.runtimeWorkspaceRoots.length
                        : null,
                      environments: Array.isArray(thread.environments)
                        ? thread.environments.length
                        : null,
                    };
                  }
                  if (responseTo === "mcpServerStatus/list") {
                    const result = record(payload.result);
                    const inventory = Array.isArray(result.data) ? result.data.map(record) : [];
                    observation = {
                      servers: inventory.length,
                      tools: inventory.reduce(
                        (sum, server) => sum + Object.keys(record(server.tools)).length,
                        0,
                      ),
                      resources: inventory.reduce(
                        (sum, server) =>
                          sum + (Array.isArray(server.resources) ? server.resources.length : 0),
                        0,
                      ),
                      resourceTemplates: inventory.reduce(
                        (sum, server) =>
                          sum +
                          (Array.isArray(server.resourceTemplates)
                            ? server.resourceTemplates.length
                            : 0),
                        0,
                      ),
                      hasNextPage: result.nextCursor !== null,
                    };
                  }
                  append("protocol-metadata.jsonl", {
                    effort,
                    process: totals.processes,
                    direction: event.direction,
                    stage: event.stage,
                    method,
                    ...(responseTo ? { responseTo } : {}),
                    ...(observation ? { observation } : {}),
                    ...(payload.error ? { errorCode: record(payload.error).code } : {}),
                  });
                  if (responseTo && id !== undefined) requests.delete(id);
                  return (
                    totals.serverRequests > 0 ||
                    totals.decodeFailures > 0 ||
                    totals.nativeErrors > 0 ||
                    totals.toolItems > 0 ||
                    totals.concurrentTurnsMax > 1
                  );
                }).pipe(
                  Effect.flatMap((unexpected) =>
                    unexpected
                      ? Deferred.fail(
                          protocolFailure,
                          new Error("Native protocol/isolation error; no retry"),
                        ).pipe(Effect.asVoid)
                      : Effect.void,
                  ),
                ),
            }),
          );
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
          return { client, cwd };
        }),
      );
      yield* Effect.addFinalizer(() => decider.close);
      for (let sample = 1; sample <= samples; sample++) {
        for (const testCase of selectedCases) {
          const sampleCase = caseForSample(testCase, `${leaseId}:${++version}`);
          const snapshot = snapshotFor(sampleCase, leaseId, version);
          const before = { ...totals };
          const cold = !opened;
          const started = NodePerfHooks.performance.now();
          const result = yield* Effect.exit(
            decider
              .decide({ snapshot, modelSelection })
              .pipe(Effect.raceFirst(Deferred.await(protocolFailure))),
          );
          const decisionWallMs = NodePerfHooks.performance.now() - started;
          if (Exit.isFailure(result)) {
            const error = record(Cause.squash(result.cause));
            failure = {
              case: testCase.id,
              caseSource: testCase.source,
              rubric: testCase.rubric,
              effort,
              sample,
              cold,
              snapshot,
              decisionWallMs,
              tag: error._tag ?? error.name ?? "EffectFailure",
              reason: error.reason ?? null,
              providerMessage: sanitize(error.providerMessage),
              message: sanitize(error.message),
              totals: { ...totals },
            };
            write("failure.json", failure);
            throw new Error("Native qualification stopped; see private failure.json");
          }
          opened = true;
          const gradeResult = grade(sampleCase, snapshot, result.value);
          const row = {
            case: testCase.id,
            caseSource: testCase.source,
            rubric: testCase.rubric,
            effort,
            sample,
            cold,
            decisionWallMs,
            processOpens: totals.processes - before.processes,
            initialize: totals.initialize - before.initialize,
            nativeTurns: totals.turnStarts - before.turnStarts,
            snapshot,
            decision: result.value,
            grade: gradeResult,
          };
          rows.push(row);
          append("results.jsonl", row);
          yield* Console.log(
            yield* encodeJson({
              case: testCase.id,
              effort,
              sample,
              cold,
              decisionWallMs: Math.round(decisionWallMs),
              pass: gradeResult.pass,
              failures: gradeResult.failures,
            }),
          );
          if (totals.turnStarts === 1)
            write("setup.json", {
              nativeSetupPassed: true,
              grade: gradeResult,
              totals: { ...totals },
            });
          if (
            totals.serverRequests ||
            totals.decodeFailures ||
            totals.nativeErrors ||
            totals.toolItems ||
            totals.concurrentTurnsMax > 1
          )
            throw new Error("Protocol/isolation invariant failed; no retry");
        }
      }
      const countBeforeFence = totals.turnStarts;
      const mismatched = yield* Effect.exit(
        decider.decide({
          snapshot: { ...snapshotFor(selectedCases[0]!, leaseId, ++version), generation: 2 },
          modelSelection,
        }),
      );
      if (Exit.isSuccess(mismatched) || totals.turnStarts !== countBeforeFence)
        throw new Error("Lease-generation fence failed");
      yield* decider.close;
      const afterClose = yield* Effect.exit(
        decider.decide({
          snapshot: snapshotFor(selectedCases[0]!, leaseId, ++version),
          modelSelection,
        }),
      );
      if (Exit.isSuccess(afterClose) || totals.turnStarts !== countBeforeFence)
        throw new Error("Closed lease accepted work");
      write(`lease-${effort}.json`, {
        generationMismatchRejectedWithoutTurn: true,
        closedLeaseRejectedWithoutTurn: true,
      });
    }
  }),
);

let exitCode = 0;
try {
  await runRuntime(program);
} catch {
  exitCode = 1;
  if (!failure) failure = { reason: "runner_or_isolation_failure", totals: { ...totals } };
}
const pidsStillAlive = ownedPids.filter((pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
});
const groups = efforts.map((effort) => ({
  effort,
  cases: selectedCases.map((testCase) => {
    const matching = rows.filter((row) => row.case === testCase.id && row.effort === effort);
    const passed = matching.filter((row) => record(row.grade).pass === true).length;
    return {
      id: testCase.id,
      passed,
      samples: matching.length,
      pass: matching.length === samples && passed > matching.length / 2,
    };
  }),
}));
const distribution = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length
    ? {
        n: sorted.length,
        medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1]! + sorted[middle]!) / 2,
        p90NearestRankMs: sorted[Math.ceil(sorted.length * 0.9) - 1],
        minMs: sorted[0],
        maxMs: sorted.at(-1),
      }
    : { n: 0 };
};
const timings = efforts.map((effort) => {
  const matching = rows.filter((row) => row.effort === effort);
  return {
    effort,
    cold: distribution(matching.filter((row) => row.cold).map((row) => Number(row.decisionWallMs))),
    warm: distribution(
      matching.filter((row) => !row.cold).map((row) => Number(row.decisionWallMs)),
    ),
    warmPassing: distribution(
      matching
        .filter((row) => !row.cold && record(row.grade).pass)
        .map((row) => Number(row.decisionWallMs)),
    ),
  };
});
const sourceDigestsAfter = await runRuntime(sourceDigests());
const summary = {
  exitCode,
  failure,
  totals,
  groups,
  timings,
  leaseFences: efforts.map((effort) => ({
    effort,
    completed: NodeFS.existsSync(path.join(output, `lease-${effort}.json`)),
  })),
  rows: rows.length,
  pidsStillAlive,
  sourceDigestsAfter,
  sourceStableDuringRun:
    JSON.stringify(manifest.sourceDigests) === JSON.stringify(sourceDigestsAfter),
  measurement:
    "wall time from decide call until validated structured decision; cold includes process and initialization; no dispatch or audio measurement",
  limitations: [
    "Each decision has fresh segment and intent IDs with consistently remapped provenance and expected targets. Identical prior source identity cannot justify deduplication. Text and rubric are unchanged, so samples remain semantically dependent within one warm thread per effort; this is not statistical independence.",
    "Effort order is fixed. Cold counts are small and warm counts may differ after an abort; timings reports actual denominators. This is not a statistically controlled latency comparison.",
    "The production factory's 32-turn history rotation is not reached by at most 18 decisions per effort lease. Generation and closed-lease fences run only after an effort completes, without starting another native turn; leaseFences reports which completed.",
    "No task admission, real work, first audio, playback or end-to-end Voice acceptance is measured.",
  ],
  baseline: values.baseline
    ? Schema.decodeSync(Json)(NodeFS.readFileSync(values.baseline, "utf8"))
    : null,
};
if (
  pidsStillAlive.length ||
  totals.cwdRemoved !== totals.processes ||
  groups.some((group) => group.cases.some((testCase) => !testCase.pass))
)
  exitCode = 1;
write("summary.json", { ...summary, exitCode });
await runRuntime(
  encodeJson({ output, exitCode, totals, groups, pidsStillAlive }).pipe(
    Effect.flatMap(Console.log),
  ),
);
process.exitCode = exitCode;

import { DeviceHostId, ModelSelection, ProjectId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { baseSshArgs, buildSshHostSpecEffect, resolveSshCommand } from "@t3tools/ssh/command";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  CREW_MAX_CAPTURE_BYTES,
  CREW_MAX_LINE_LENGTH,
  CREW_MAX_REQUESTS,
  CrewRunnerFrame,
  CrewSummary,
  decodeCrewFrame,
  encodeCrewFrame,
} from "../../../../evals/shared/crewProviderProtocol.ts";
import * as BoatService from "../boat/BoatService.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderEvalSession from "./ProviderEvalSession.ts";

export const ProviderEvalBoatInput = Schema.Struct({
  projectId: ProjectId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  hostId: DeviceHostId,
  modelSelection: ModelSelection,
  caseIds: Schema.Array(
    Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  samples: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
});
export type ProviderEvalBoatInput = typeof ProviderEvalBoatInput.Type;

export const ProviderEvalBoatResult = Schema.Struct({
  jobId: Schema.String,
  exitCode: Schema.Int,
  outputDirectory: Schema.String,
  stdoutPath: Schema.String,
  stderrPath: Schema.String,
  summary: CrewSummary,
});
export type ProviderEvalBoatResult = typeof ProviderEvalBoatResult.Type;

export class ProviderEvalBoatError extends Schema.TaggedError<ProviderEvalBoatError>()(
  "ProviderEvalBoatError",
  {
    code: Schema.Literals([
      "invalid_input",
      "boat_unavailable",
      "host_mismatch",
      "storage",
      "ssh",
      "protocol",
      "provider",
      "timeout",
      "output_limit",
    ]),
    stdoutPath: Schema.optional(Schema.String),
    stderrPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Boat evaluation failed (${this.code}). The registered Boat and Crew stdio runner are required.`;
  }
}

export class ProviderEvalBoat extends Context.Service<
  ProviderEvalBoat,
  {
    readonly run: (
      input: ProviderEvalBoatInput,
    ) => Effect.Effect<
      ProviderEvalBoatResult,
      ProviderEvalBoatError,
      McpInvocationContext.McpInvocationContext
    >;
  }
>()("t3/provider/ProviderEvalBoat") {}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const encoder = new TextEncoder();

const make = Effect.gen(function* () {
  const boats = yield* BoatService.BoatService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const sessions = yield* ProviderEvalSession.ProviderEvalSession;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const ssh = yield* resolveSshCommand;
  const home = yield* HostProcess.HomeDirectory;

  const run: ProviderEvalBoat["Service"]["run"] = Effect.fn("ProviderEvalBoat.run")(
    function* (input) {
      yield* McpInvocationContext.McpInvocationContext;
      const checked = yield* Schema.decodeUnknownEffect(ProviderEvalBoatInput)(input).pipe(
        Effect.mapError((cause) => new ProviderEvalBoatError({ code: "invalid_input", cause })),
      );
      if (new Set(checked.caseIds).size !== checked.caseIds.length) {
        return yield* new ProviderEvalBoatError({ code: "invalid_input" });
      }
      const state = yield* boats
        .read(checked.projectId)
        .pipe(
          Effect.mapError(
            (cause) => new ProviderEvalBoatError({ code: "boat_unavailable", cause }),
          ),
        );
      const boat = state.instances.find(
        (entry) => entry.projectId === checked.projectId && entry.requestId === checked.requestId,
      );
      if (!boat?.sandboxId || !["idle", "ready", "running"].includes(boat.state)) {
        return yield* new ProviderEvalBoatError({ code: "boat_unavailable" });
      }
      const config = yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new ProviderEvalBoatError({ code: "host_mismatch", cause })),
      );
      const host = config.deviceHosts.find((entry) => entry.id === checked.hostId);
      if (
        !host ||
        (host.id !== `boat-${boat.sandboxId}` && host.label !== `boat-${boat.sandboxId}`)
      ) {
        return yield* new ProviderEvalBoatError({ code: "host_mismatch" });
      }
      const target = {
        alias: host.target,
        hostname: host.target,
        username: null,
        port: host.port ?? null,
      };
      const hostSpec = yield* buildSshHostSpecEffect(target).pipe(
        Effect.mapError((cause) => new ProviderEvalBoatError({ code: "host_mismatch", cause })),
      );
      const jobId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const outputDirectory = `/home/user/.cache/crew-evals/${jobId}`;
      const captureDirectory = path.join(home, ".cache", "crew", "provider-evals", jobId);
      const stdoutPath = path.join(captureDirectory, "ssh.stdout.log");
      const stderrPath = path.join(captureDirectory, "ssh.stderr.log");
      const fail = (code: ProviderEvalBoatError["code"], cause?: unknown) =>
        new ProviderEvalBoatError({
          code,
          stdoutPath,
          stderrPath,
          ...(cause === undefined ? {} : { cause }),
        });
      const args = [
        "node",
        "evals/mcp-tool-use/run.ts",
        "--transport",
        "crew",
        "--crew-stdio",
        "--model",
        checked.modelSelection.model,
        "--case",
        checked.caseIds.join(","),
        "--samples",
        String(checked.samples),
        "--concurrency",
        "1",
        "--out",
        outputDirectory,
      ];
      const script = `set -eu\numask 077\nmkdir -p -- ${quote(outputDirectory)}\ncd /home/user/crew\nexec timeout --signal=TERM --kill-after=5s 900s ${args.map(quote).join(" ")}`;
      const program = Effect.gen(function* () {
        const storageError = (cause: unknown) => fail("storage", cause);
        yield* fs
          .makeDirectory(captureDirectory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(storageError));
        yield* fs.chmod(captureDirectory, 0o700).pipe(Effect.mapError(storageError));
        yield* fs
          .writeFileString(
            path.join(captureDirectory, "manifest.json"),
            JSON.stringify({
              jobId,
              purpose: "Bounded private Boat eval SSH captures",
              maxBytesPerStream: CREW_MAX_CAPTURE_BYTES,
              retention:
                "Until the task owner removes this job directory; no automatic retention guarantee.",
            }),
            { mode: 0o600 },
          )
          .pipe(Effect.mapError(storageError));
        const stdout = yield* fs
          .open(stdoutPath, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(storageError));
        const stderr = yield* fs
          .open(stderrPath, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError(storageError));
        const capture = (file: FileSystem.File) => {
          let written = 0;
          return Effect.fn("ProviderEvalBoat.capture")(function* (bytes: Uint8Array) {
            const room = CREW_MAX_CAPTURE_BYTES - written;
            yield* file.writeAll(bytes.subarray(0, room)).pipe(Effect.mapError(storageError));
            written += bytes.length;
            if (written > CREW_MAX_CAPTURE_BYTES) return yield* fail("output_limit");
          });
        };
        const replies = yield* Queue.bounded<string>(4);
        const owned = new Set<string>();
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            owned,
            (evaluationId) => sessions.run({ action: "cancel", evaluationId }).pipe(Effect.ignore),
            { discard: true },
          ),
        );
        const child = yield* spawner.spawn(
          ChildProcess.make(
            ssh,
            [
              ...baseSshArgs(target, { batchMode: "yes" }),
              "-o",
              "StrictHostKeyChecking=yes",
              "-o",
              "ServerAliveInterval=15",
              "-o",
              "ServerAliveCountMax=3",
              ...(host.identityFile ? ["-i", host.identityFile] : []),
              "--",
              hostSpec,
              "sh",
              "-c",
              quote(script),
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe", forceKillAfter: "5 seconds" },
          ),
        );
        const received: { ready: boolean; summary?: CrewSummary } = { ready: false };
        const seen = new Set<string>();
        let pending = "";
        const handleLine = Effect.fn("ProviderEvalBoat.handleLine")(function* (line: string) {
          const frame = yield* decodeCrewFrame(CrewRunnerFrame, line).pipe(
            Effect.mapError((cause) => fail("protocol", cause)),
          );
          if (frame.type === "ready") {
            if (received.ready) return yield* fail("protocol");
            received.ready = true;
            return;
          }
          if (!received.ready || received.summary !== undefined) return yield* fail("protocol");
          if (frame.type === "result") {
            if (
              owned.size !== 0 ||
              frame.summary.cases !== checked.caseIds.length ||
              frame.summary.samples !== checked.caseIds.length * checked.samples ||
              frame.summary.passed + frame.summary.failed + frame.summary.errors !==
                frame.summary.samples
            ) {
              return yield* fail("protocol");
            }
            received.summary = frame.summary;
            return;
          }
          if (seen.has(frame.id) || seen.size >= CREW_MAX_REQUESTS) return yield* fail("protocol");
          seen.add(frame.id);
          const request = frame.request;
          if (
            (request.action === "start" && owned.size !== 0) ||
            (request.action !== "start" && !owned.has(request.evaluationId))
          ) {
            return yield* fail("protocol");
          }
          const response = yield* sessions
            .run(
              request.action === "start"
                ? {
                    ...request,
                    modelSelection: checked.modelSelection,
                    clientRequestId: `${jobId}:${frame.id}`,
                  }
                : request,
            )
            .pipe(
              Effect.mapError((cause) => fail("provider", cause)),
              Effect.raceFirst(
                child.exitCode.pipe(
                  Effect.mapError((cause) => fail("ssh", cause)),
                  Effect.andThen(Effect.fail(fail("ssh"))),
                ),
              ),
            );
          if (response.type === "tool_call") owned.add(response.evaluationId);
          else {
            if (response.type === "complete") {
              owned.add(response.evaluationId);
              yield* sessions
                .run({ action: "cancel", evaluationId: response.evaluationId })
                .pipe(Effect.mapError((cause) => fail("provider", cause)));
            }
            owned.delete(response.evaluationId);
          }
          const reply = encodeCrewFrame({ type: "response", id: frame.id, response });
          if (reply.length > CREW_MAX_LINE_LENGTH) return yield* fail("output_limit");
          yield* Queue.offer(replies, reply);
        });
        const decoder = new TextDecoder();
        const [, , exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.tap(capture(stdout)),
              Stream.mapEffect((bytes) =>
                Effect.gen(function* () {
                  pending += decoder.decode(bytes, { stream: true });
                  let newline: number;
                  while ((newline = pending.indexOf("\n")) !== -1) {
                    const line = pending.slice(0, newline);
                    pending = pending.slice(newline + 1);
                    yield* handleLine(line);
                  }
                  if (pending.length > CREW_MAX_LINE_LENGTH) return yield* fail("output_limit");
                }),
              ),
              Stream.runDrain,
              Effect.ensuring(Queue.end(replies)),
            ),
            child.stderr.pipe(Stream.runForEach(capture(stderr))),
            child.exitCode,
            Stream.fromQueue(replies).pipe(
              Stream.map((line) => encoder.encode(line)),
              Stream.run(child.stdin),
            ),
          ],
          { concurrency: "unbounded" },
        );
        if (!received.ready || !received.summary || pending.length !== 0)
          return yield* fail("protocol");
        return {
          jobId,
          exitCode: Number(exitCode),
          outputDirectory,
          stdoutPath,
          stderrPath,
          summary: received.summary,
        };
      }).pipe(
        Effect.scoped,
        Effect.mapError((cause) =>
          cause instanceof ProviderEvalBoatError ? cause : fail("ssh", cause),
        ),
        Effect.timeoutOrElse({
          duration: "16 minutes",
          orElse: () => Effect.fail(fail("timeout")),
        }),
      );
      return yield* program;
    },
  );
  return ProviderEvalBoat.of({ run });
});

export const layer = Layer.effect(ProviderEvalBoat, make);

import type { AppRestoreInput, AppRestoreState } from "@t3tools/contracts";
import {
  listDesktopRestores,
  releaseDesktopUpdateHold,
  restoreDesktopVersion,
} from "@t3tools/shared/desktopRestore";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, Prompt } from "effect/cli";

import {
  listServerRestore,
  releaseServerUpdateHold,
  restoreServerVersion,
} from "../cloud/serverRestore.ts";
import { resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

class RestoreCliError extends Schema.TaggedError<RestoreCliError>()("RestoreCliError", {
  reason: Schema.String,
  exitCode: Schema.Number,
}) {
  override get message() {
    return this.reason;
  }
}

const failure = (reason: string, exitCode = 3) => new RestoreCliError({ reason, exitCode });

export function selectRestoreTarget(
  state: AppRestoreState,
  input: {
    version: string;
    expectedHash?: string;
    expectedCurrentVersion?: string;
  },
): AppRestoreInput {
  if (state.unavailableReason) throw failure(state.unavailableReason);
  const target = state.candidates.find((candidate) => candidate.version === input.version);
  if (!target)
    throw failure(
      `Version ${input.version} is not retained for this ${state.component} installation.`,
    );
  if (target.blockedReason) throw failure(target.blockedReason);
  if (input.expectedHash !== undefined && input.expectedHash !== target.sha256)
    throw failure("The retained artifact hash changed. Read the version list again.");
  if (
    input.expectedCurrentVersion !== undefined &&
    input.expectedCurrentVersion !== state.currentVersion
  )
    throw failure("The current version changed. Read the version list again.");
  return {
    version: target.version,
    expectedCurrentVersion: state.currentVersion,
    expectedHash: target.sha256,
  };
}

const showState = Effect.fn("cli.restore.showState")(function* (
  state: AppRestoreState,
  json: boolean,
) {
  if (json) return yield* Console.log(JSON.stringify(state));
  yield* Console.log(`Crew ${state.component}: ${state.currentVersion} (${state.installationId})`);
  yield* Console.log(
    `Automatic updates: ${state.updateHold ? "on hold" : "enabled"}. Retained: ${state.totalBytes}/${state.maxBytes} bytes; up to ${state.maxVersions} versions.`,
  );
  if (state.unavailableReason) yield* Console.log(state.unavailableReason);
  for (const candidate of state.candidates) {
    yield* Console.log(
      `${candidate.version}  ${candidate.sizeBytes} bytes  sha256:${candidate.sha256}${candidate.blockedReason ? `  BLOCKED: ${candidate.blockedReason}` : ""}`,
    );
  }
  if (!state.candidates.length) yield* Console.log("No verified previous version is retained yet.");
});

const optionalString = (name: string, description: string) =>
  Flag.String(name).pipe(Flag.withDescription(description), Flag.optional);

export const restoreCommand = Command.make("restore", {
  baseDir: baseDirFlag,
  component: Flag.Literals("component", ["desktop", "server"]).pipe(
    Flag.withDefault("desktop"),
    Flag.withDescription("Installation to restore on this machine."),
  ),
  version: Argument.String("version").pipe(Argument.optional),
  list: Flag.Boolean("list").pipe(
    Flag.withDefault(false),
    Flag.withDescription("List retained versions without changing the installation."),
  ),
  json: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Print machine-readable JSON; never prompt."),
  ),
  yes: Flag.Boolean("yes").pipe(
    Flag.withDefault(false),
    Flag.withAlias("y"),
    Flag.withDescription("Confirm the exact version switch and controlled restart."),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Validate the target and print the plan without switching."),
  ),
  resumeUpdates: Flag.Boolean("resume-updates").pipe(
    Flag.withDefault(false),
    Flag.withDescription("Release the persistent automatic-update hold."),
  ),
  expectedHash: optionalString("expected-hash", "Require this exact SHA-256 from --list --json."),
  expectedCurrentVersion: optionalString(
    "expected-current-version",
    "Refuse if another operation changed the current version.",
  ),
}).pipe(
  Command.withDescription(
    "Restore a verified retained Crew app version without changing chats, login or profile. Works without the GUI.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const configuredHome =
        Option.getOrUndefined(flags.baseDir) ??
        Option.getOrUndefined(yield* Config.String("T3CODE_HOME").pipe(Config.option));
      const baseDir = yield* resolveBaseDir(configuredHome);
      const invokeDesktop = <A>(operation: () => Promise<A>) =>
        Effect.tryPromise({
          try: operation,
          catch: (cause) =>
            failure(cause instanceof Error ? cause.message : "Desktop restore could not complete."),
        });
      const list =
        flags.component === "desktop"
          ? invokeDesktop(() => listDesktopRestores({ baseDir }))
          : listServerRestore({ baseDir });
      const state = yield* list;
      let version = Option.getOrUndefined(flags.version);
      if (
        (flags.resumeUpdates && (version !== undefined || flags.list || flags.dryRun)) ||
        (flags.list && (version !== undefined || flags.dryRun))
      )
        return yield* failure("Use --list, a target version, or --resume-updates separately.", 2);
      if (version === undefined && !flags.resumeUpdates && !flags.list && flags.yes)
        return yield* failure(
          "Specify an exact retained version with --yes. Use --list to inspect available versions.",
          2,
        );
      if (version === undefined && flags.json && flags.dryRun)
        return yield* failure("A JSON restore plan requires an exact retained version.", 2);

      if (flags.resumeUpdates) {
        const interactive = !flags.json && process.stdin.isTTY && process.stdout.isTTY;
        const confirmed =
          flags.yes ||
          (interactive &&
            (yield* Prompt.run(
              Prompt.Confirm({
                message: `Resume automatic updates for Crew ${flags.component} at ${baseDir}?`,
                initial: false,
              }),
            ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }))));
        if (!confirmed)
          return yield* failure("Resuming updates requires --yes or interactive confirmation.", 2);
        const resumed = yield* flags.component === "desktop"
          ? invokeDesktop(() => releaseDesktopUpdateHold({ baseDir }))
          : releaseServerUpdateHold({ baseDir });
        return yield* showState(resumed, flags.json);
      }

      if (
        flags.list ||
        (version === undefined &&
          (flags.json || !process.stdin.isTTY || !process.stdout.isTTY || flags.yes))
      )
        return yield* showState(state, flags.json);

      if (version === undefined) {
        yield* showState(state, false);
        const choices = state.candidates.filter((candidate) => candidate.blockedReason === null);
        if (state.unavailableReason || !choices.length)
          return yield* failure(
            state.unavailableReason ?? "No compatible retained version is available.",
          );
        const chosen = yield* Prompt.run(
          Prompt.Select({
            message: "Restore Crew to",
            choices: choices.map((candidate) => ({
              title: `${candidate.version} (${candidate.sizeBytes} bytes)`,
              value: candidate.version,
            })),
          }),
        ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(null) }));
        if (chosen === null) return yield* failure("Restore cancelled.", 2);
        version = chosen;
      }

      const targetVersion = version;
      const input = yield* Effect.try({
        try: () =>
          selectRestoreTarget(state, {
            version: targetVersion,
            expectedHash: Option.getOrUndefined(flags.expectedHash),
            expectedCurrentVersion: Option.getOrUndefined(flags.expectedCurrentVersion),
          }),
        catch: (cause) =>
          cause instanceof RestoreCliError ? cause : failure("The restore target is invalid.", 2),
      });
      if (flags.dryRun) {
        const plan = {
          component: flags.component,
          installationId: state.installationId,
          ...input,
          updateHold: true,
          restart: true,
        };
        return yield* Console.log(
          flags.json
            ? JSON.stringify(plan)
            : `Restore ${state.currentVersion} → ${input.version}; sha256:${input.expectedHash}. Crew will restart and automatic updates will be held. No changes made.`,
        );
      }
      const interactive = !flags.json && process.stdin.isTTY && process.stdout.isTTY;
      const confirmed =
        flags.yes ||
        (interactive &&
          (yield* Prompt.run(
            Prompt.Confirm({
              message: `Restore Crew ${flags.component} ${state.currentVersion} → ${input.version} (${input.expectedHash}) and restart? Automatic updates will be held.`,
              initial: false,
            }),
          ).pipe(Effect.catchTags({ QuitError: () => Effect.succeed(false) }))));
      if (!confirmed)
        return yield* failure(
          "Restore requires --yes or interactive confirmation. Use --dry-run to inspect the target.",
          2,
        );
      const result = yield* flags.component === "desktop"
        ? invokeDesktop(() => restoreDesktopVersion({ baseDir, ...input }))
        : restoreServerVersion({ baseDir, ...input });
      if (result.status === "failed")
        return yield* failure(
          result.reason ?? "Restore failed; inspect the restore status before retrying.",
        );
      yield* Console.log(
        flags.json
          ? JSON.stringify(result)
          : `${result.status === "restored" ? "Restored" : "Restore scheduled for"} Crew ${result.version}.${result.reason ? ` ${result.reason}` : ""}`,
      );
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const message = error instanceof Error ? error.message : "Restore could not complete.";
          const exitCode = error instanceof RestoreCliError ? error.exitCode : 3;
          process.exitCode = exitCode;
          if (flags.json)
            yield* Console.log(JSON.stringify({ status: "failed", error: message, exitCode }));
          else yield* Console.error(message);
        }),
      ),
    ),
  ),
);

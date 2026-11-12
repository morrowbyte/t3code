// @effect-diagnostics nodeBuiltinImport:off -- Host-wide private route ownership survives controller death.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as HostProcess from "../HostProcess.ts";
import {
  captureIdentity,
  isProvenDead,
  ProcessIdentity,
  ShareRuntime,
  shareRuntimeStopped,
} from "./devRunnerControl.ts";

export interface Ownership {
  readonly port: number;
  readonly generation: string;
}

export const makeOwnership = (port: number): Ownership => ({
  port,
  generation: NodeCrypto.randomBytes(32).toString("hex"),
});

const Entry = Schema.Struct({
  generation: Schema.String,
  owner: Schema.optionalKey(ProcessIdentity),
  routes: Schema.Array(Schema.String),
  runtime: Schema.optionalKey(ShareRuntime),
  cleared: Schema.Boolean,
});
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Entry));
const Config = Schema.Struct({
  TCP: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  Web: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const Status = Schema.NullOr(
  Schema.Struct({
    ...Config.fields,
    Foreground: Schema.optionalKey(Schema.Record(Schema.String, Config)),
    Services: Schema.optionalKey(Schema.Record(Schema.String, Config)),
  }),
);
const decodeStatus = Schema.decodeUnknownOption(Schema.fromJsonString(Status));

const fingerprint = (routes: ReadonlyArray<unknown>) =>
  JSON.stringify(routes, (_key, value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  });

export const expectedRoute = (input: {
  readonly port: number;
  readonly host: string;
  readonly proxy: string;
}) =>
  fingerprint([
    ["", "TCP", { HTTPS: true }],
    ["", `${input.host}:${input.port}`, { Handlers: { "/": { Proxy: input.proxy } } }],
  ]);

const readRoute = Effect.fn("devShareOwnership.readRoute")(function* (port: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const raw = yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(
          platform === "win32" ? "tailscale.exe" : "tailscale",
          ["serve", "status", "--json"],
          { stdin: "ignore", stderr: "ignore", forceKillAfter: "500 millis" },
        ),
      );
      const limit = 2 * 1024 * 1024;
      const [stdout, exitCode] = yield* Effect.all(
        [
          Stream.runFold(
            Stream.decodeText(child.stdout),
            () => "",
            (text, chunk) =>
              text.length > limit ? text : text + chunk.slice(0, limit + 1 - text.length),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return exitCode === 0 && stdout.length <= limit ? stdout : undefined;
    }),
  ).pipe(Effect.timeout("3500 millis"), Effect.option);
  if (Option.isNone(raw) || raw.value === undefined) return undefined;
  const parsed = decodeStatus(raw.value);
  if (Option.isNone(parsed)) return undefined;
  if (parsed.value === null) return null;
  const routes: Array<unknown> = [];
  const visit = (scope: string, config: typeof Config.Type) => {
    const tcp = config.TCP?.[String(port)];
    if (tcp !== undefined) routes.push([scope, "TCP", tcp]);
    for (const [host, handler] of Object.entries(config.Web ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (host.endsWith(`:${port}`)) routes.push([scope, host, handler]);
    }
  };
  visit("", parsed.value);
  for (const [scope, config] of Object.entries(parsed.value.Foreground ?? {}))
    visit(`foreground:${scope}`, config);
  for (const [scope, config] of Object.entries(parsed.value.Services ?? {}))
    visit(`service:${scope}`, config);
  return routes.length === 0 ? null : fingerprint(routes);
});

class OwnershipError extends Schema.TaggedError<OwnershipError>()("DevShareOwnershipError", {
  cause: Schema.Defect(),
}) {}

// One host lock covers the generation check and the route I/O, including normal finalizers.
const withOwnership = Effect.fn("devShareOwnership.withOwnership")(function* <A, E, R>(
  ownership: Ownership,
  use: (db: NodeSqlite.DatabaseSync) => Effect.Effect<A, E, R>,
) {
  const home = yield* HostProcess.HomeDirectory;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const directory = NodePath.join(home, ".t3", "dev-share-control");
      const open = (name: string) =>
        Effect.try({
          try: () => {
            NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
            const path = NodePath.join(directory, name);
            const fd = NodeFS.openSync(path, "a", 0o600);
            NodeFS.closeSync(fd);
            return new NodeSqlite.DatabaseSync(path);
          },
          catch: (cause) => new OwnershipError({ cause }),
        });
      const lock = yield* Effect.acquireRelease(open("lock.sqlite"), (db) =>
        Effect.sync(() => db.close()),
      );
      yield* Effect.try({
        try: () => lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;"),
        catch: (cause) => new OwnershipError({ cause }),
      });
      const db = yield* Effect.acquireRelease(open("ownership.sqlite"), (db) =>
        Effect.sync(() => db.close()),
      );
      yield* Effect.try({
        try: () =>
          db.exec(
            "CREATE TABLE IF NOT EXISTS routes (port INTEGER PRIMARY KEY, receipt TEXT NOT NULL);",
          ),
        catch: (cause) => new OwnershipError({ cause }),
      });
      if (
        !Number.isInteger(ownership.port) ||
        ownership.port < 1 ||
        ownership.port > 65535 ||
        !/^[a-f0-9]{64}$/u.test(ownership.generation)
      )
        return yield* new OwnershipError({ cause: "Invalid route generation" });
      return yield* use(db);
    }),
  ).pipe(Effect.catchDefect((cause) => new OwnershipError({ cause })));
});

const readEntry = (db: NodeSqlite.DatabaseSync, port: number) => {
  const row = db.prepare("SELECT receipt FROM routes WHERE port = ?").get(port);
  return row === undefined ? undefined : decodeEntry(String(row.receipt));
};
const writeEntry = (db: NodeSqlite.DatabaseSync, port: number, value: typeof Entry.Type) => {
  db.prepare("INSERT OR REPLACE INTO routes (port, receipt) VALUES (?, ?)").run(
    port,
    JSON.stringify(value),
  );
};

export const create = Effect.fn("devShareOwnership.create")(function* <A, E, R>(input: {
  readonly ownership: Ownership;
  readonly expectedRoute: string;
  readonly runtime?: typeof ShareRuntime.Type | undefined;
  readonly serve: Effect.Effect<A, E, R>;
}) {
  return yield* withOwnership(input.ownership, (db) =>
    Effect.gen(function* () {
      const { port, generation } = input.ownership;
      const previous = readEntry(db, port);
      const route = yield* readRoute(port);
      if (
        route === undefined ||
        (previous !== undefined &&
          (Option.isNone(previous) ||
            (!(previous.value.cleared && route === null) &&
              (!(yield* isProvenDead(previous.value.owner)) ||
                !(yield* shareRuntimeStopped(
                  previous.value.runtime,
                  port,
                  previous.value.generation,
                ))))))
      )
        return yield* new OwnershipError({ cause: "Route owner is active or unverified" });
      if (
        route !== null &&
        (previous === undefined ||
          Option.isNone(previous) ||
          !previous.value.routes.includes(route))
      )
        return yield* new OwnershipError({ cause: "Existing route generation is unverified" });
      const owner = yield* captureIdentity(process.pid);
      // Persist both exact possible outcomes before I/O; a lost status response cannot strand this generation.
      const pending = {
        generation,
        ...(owner === undefined ? {} : { owner }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        routes: route === null ? [input.expectedRoute] : [route, input.expectedRoute],
        cleared: false,
      };
      writeEntry(db, port, pending);
      const value = yield* input.serve;
      const created = yield* readRoute(port);
      if (created !== input.expectedRoute)
        return yield* new OwnershipError({ cause: "Created route could not be verified" });
      writeEntry(db, port, { ...pending, routes: [input.expectedRoute] });
      return value;
    }),
  ).pipe(Effect.uninterruptible);
});

export const clear = Effect.fn("devShareOwnership.clear")(function* <R>(input: {
  readonly port: number;
  readonly generation: string | undefined;
  readonly canClear: Effect.Effect<boolean>;
  readonly remove: Effect.Effect<boolean, never, R>;
}) {
  if (input.generation === undefined) return false;
  return yield* withOwnership({ port: input.port, generation: input.generation }, (db) =>
    Effect.gen(function* () {
      const entry = readEntry(db, input.port);
      if (entry === undefined || Option.isNone(entry)) return false;
      // A newer generation owns the route. Only the caller's obsolete workspace receipt may go.
      if (entry.value.generation !== input.generation) return yield* input.canClear;
      const route = yield* readRoute(input.port);
      if (route === undefined || (route !== null && !entry.value.routes.includes(route)))
        return false;
      if (!(yield* input.canClear)) return false;
      if (route !== null && !(yield* input.remove)) return false;
      if ((yield* readRoute(input.port)) !== null) return false;
      // Keep a tombstone so delayed cleanup of this generation remains idempotent.
      writeEntry(db, input.port, { ...entry.value, routes: [], cleared: true });
      return true;
    }),
  ).pipe(
    Effect.orElseSucceed(() => false),
    Effect.uninterruptible,
  );
});

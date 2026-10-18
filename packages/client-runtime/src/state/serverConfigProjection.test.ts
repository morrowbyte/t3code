import {
  EnvironmentId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { applyServerConfigProjection, reuseUnchanged } from "./serverConfigProjection.ts";

const SERVER_CONFIG: ServerConfig = {
  environment: {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Before",
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

describe("MT environment label projection", () => {
  const event = Schema.decodeUnknownSync(ServerConfigStreamEvent)({
    version: 1,
    type: "environmentLabelUpdated",
    payload: { label: "After" },
  });

  it("applies a decoded label event immutably and retains environment identity and config", () => {
    const before = Option.getOrThrow(
      applyServerConfigProjection(Option.none(), {
        version: 1,
        type: "snapshot",
        config: SERVER_CONFIG,
      }),
    );
    Object.freeze(before.config.environment);
    Object.freeze(before.config);
    const after = Option.getOrThrow(applyServerConfigProjection(Option.some(before), event));

    expect(after.config.environment.label).toBe("After");
    expect(before.config.environment.label).toBe("Before");
    expect(after.config).not.toBe(before.config);
    expect(after.config.environment).not.toBe(before.config.environment);
    expect(after.config.environment).toEqual({ ...before.config.environment, label: "After" });
    expect(after.config.settings).toBe(before.config.settings);
    expect(after.config.providers).toBe(before.config.providers);
    expect(after.config.auth).toBe(before.config.auth);
    expect(after.latestEvent).toBe(event);
    expect(after.source).toBe("live");
  });

  it("does not invent a config before the initial snapshot", () => {
    expect(Option.isNone(applyServerConfigProjection(Option.none(), event))).toBe(true);
  });
});

describe("reuseUnchanged", () => {
  const provider = (checkedAt: string, skills: ReadonlyArray<string>) => ({
    instanceId: "claude",
    checkedAt,
    models: [{ slug: "opus", name: "Opus" }],
    skills: skills.map((name) => ({ name })),
  });

  it("returns the previous value when nothing changed", () => {
    const previous = [provider("a", ["x"])];
    expect(reuseUnchanged(previous, [provider("a", ["x"])])).toBe(previous);
  });

  it("keeps unchanged parts when one field changes", () => {
    const previous = [provider("a", ["x"]), { ...provider("a", ["y"]), instanceId: "codex" }];
    const next = reuseUnchanged(previous, [
      provider("b", ["x"]),
      { ...provider("a", ["y"]), instanceId: "codex" },
    ]);
    expect(next).not.toBe(previous);
    expect(next[0]).not.toBe(previous[0]);
    expect(next[0]!.checkedAt).toBe("b");
    expect(next[0]!.models).toBe(previous[0]!.models);
    expect(next[0]!.skills).toBe(previous[0]!.skills);
    expect(next[1]).toBe(previous[1]);
  });

  it("takes the new value when keys or lengths change", () => {
    const previous = [provider("a", ["x"])];
    const next = reuseUnchanged(previous, [provider("a", ["x", "z"])]);
    expect(next[0]!.skills).toHaveLength(2);
    expect(next[0]!.models).toBe(previous[0]!.models);
    const dropped = reuseUnchanged({ a: 1, b: 2 }, { a: 1 });
    expect(dropped).toEqual({ a: 1 });
  });
});

describe("applyServerConfigProjection snapshot", () => {
  const snapshot = (checkedAt: string) =>
    ({
      type: "snapshot",
      config: {
        environment: { capabilities: {} },
        providers: [{ instanceId: "claude", checkedAt, skills: [{ name: "review" }] }],
      },
    }) as unknown as ServerConfigStreamEvent;
  const providersOf = (projection: ReturnType<typeof applyServerConfigProjection>) =>
    (Option.getOrThrow(projection).config as ServerConfig).providers;

  it("keeps unchanged skills when a reconnect re-sends the config", () => {
    const first = applyServerConfigProjection(Option.none(), snapshot("a"));
    const second = applyServerConfigProjection(first, snapshot("b"));
    expect(providersOf(second)[0]!.checkedAt).toBe("b");
    expect(providersOf(second)[0]!.skills).toBe(providersOf(first)[0]!.skills);
  });
});

describe("applyServerConfigProjection settingsUpdated", () => {
  it("keeps unchanged settings sections when one field changes", () => {
    const settings = {
      favorites: [{ provider: "claude", model: "opus" }],
      providerInstances: {
        claude: { driver: "claudeAgent", config: { launchArgs: "" } },
        codex: { driver: "codex" },
      },
    };
    const current = Option.some({
      config: { settings } as unknown as ServerConfig,
      latestEvent: {} as ServerConfigStreamEvent,
      source: "live" as const,
    });
    const next = applyServerConfigProjection(current, {
      type: "settingsUpdated",
      payload: {
        settings: {
          favorites: [{ provider: "claude", model: "opus" }],
          providerInstances: {
            claude: { driver: "claudeAgent", config: { launchArgs: "--verbose" } },
            codex: { driver: "codex" },
          },
        },
      },
    } as unknown as ServerConfigStreamEvent);
    const nextSettings = Option.getOrThrow(next).config.settings as unknown as typeof settings;
    expect(nextSettings.favorites).toBe(settings.favorites);
    expect(nextSettings.providerInstances.codex).toBe(settings.providerInstances.codex);
    expect(nextSettings.providerInstances.claude.config.launchArgs).toBe("--verbose");
  });
});

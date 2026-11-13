import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as DesktopBrowserHost from "../preview/DesktopBrowserHost.ts";
import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

it.effect("does not register buffered Ready after the helper stopped before host assignment", () =>
  Effect.gen(function* () {
    const environmentId = "00000000-0000-4000-8000-000000000002";
    const target = { alias: "target-a", hostname: "target-a", username: null, port: null };
    const bootstrap = {
      target,
      httpBaseUrl: "http://127.0.0.1:41773",
      wsBaseUrl: "ws://127.0.0.1:41773",
      pairingToken: null,
    };
    const host = yield* DesktopBrowserHost.make;
    let createdConnections = 0;
    let helperStopped = false;
    const manager = SshTunnel.SshEnvironmentManager.of({
      ensureEnvironment: () => Effect.succeed(bootstrap),
      disconnectEnvironment: () => Effect.void,
      openDesktopBrowser: (_target, _environmentId, _events, beforeClose) =>
        Effect.gen(function* () {
          yield* beforeClose ?? Effect.void;
          helperStopped = true;
          return {
            proxyUrl: "socks5://127.0.0.1:41774",
            commands: Stream.make(
              new TextEncoder().encode(
                JSON.stringify({
                  type: "desktop-browser-ready",
                  environmentId,
                  processEpoch: "stopped-process",
                }) + "\n",
              ),
            ),
            closed: Effect.void,
          };
        }),
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            environmentId,
            label: "Target A",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: false },
          }),
        ),
      ),
    );
    const environment = yield* DesktopSshEnvironment.make.pipe(
      Effect.provideService(SshTunnel.SshEnvironmentManager, manager),
      Effect.provideService(DesktopBrowserHost.DesktopBrowserHost, {
        ...host,
        createConnection: (...args) => {
          createdConnections++;
          return host.createConnection(...args);
        },
      }),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts)({}),
          NetService.layer,
          NodeServices.layer,
        ),
      ),
    );
    assert.deepEqual(yield* environment.ensureEnvironment(target), bootstrap);
    assert.isTrue(helperStopped);
    assert.equal(createdConnections, 0);
    assert.deepEqual(host.hostedEnvironmentIds(), []);
  }).pipe(Effect.scoped),
);

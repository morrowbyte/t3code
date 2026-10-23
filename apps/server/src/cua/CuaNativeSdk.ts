import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as CuaDriverHost from "./CuaDriverHost.ts";
import * as CuaInstallation from "./CuaInstallation.ts";
import { loadCuaSdk } from "./CuaSdkModule.ts";

export const layer = Layer.effect(
  CuaDriverHost.CuaEmbeddedSdk,
  Effect.gen(function* () {
    const installation = yield* CuaInstallation.CuaInstallation;
    const executable = yield* HostProcess.ExecutablePath;
    const standalone = yield* HostProcess.IsExecutable;
    const entry = (yield* HostProcess.Arguments)[1];
    return CuaDriverHost.CuaEmbeddedSdk.of({
      acquire: installation.acquire.pipe(
        Effect.mapError((cause) => new CuaDriverHost.CuaDriverError({ operation: "start", cause })),
        Effect.flatMap((binaryPath) =>
          Effect.try({
            try: () => {
              if (!standalone && !entry) throw new Error("Missing Cua session wrapper entrypoint");
              const host = new (loadCuaSdk(binaryPath).EmbeddedCuaDriverHost)(
                binaryPath,
                "com.morrowbyte.t3code",
              );
              return {
                start: async (options?: { signal: AbortSignal }) => {
                  const connection = await host.start(options);
                  return {
                    ...connection,
                    mcp: {
                      command: executable,
                      args: [
                        ...(standalone ? [] : [entry!]),
                        "cua-session-mcp",
                        connection.mcp.command,
                        ...connection.mcp.args,
                      ],
                      environment: [
                        ...connection.mcp.environment,
                        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
                      ],
                    },
                  };
                },
                stop: (options?: { signal: AbortSignal }) => host.stop(options),
                waitForExit: (generation: string, options?: { signal: AbortSignal }) =>
                  host.waitForExit(generation, options),
                uniffiDestroy: () => host.uniffiDestroy(),
              };
            },
            catch: (cause) => new CuaDriverHost.CuaDriverError({ operation: "start", cause }),
          }),
        ),
      ),
    });
  }),
);

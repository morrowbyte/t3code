import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CuaDriverHost from "./CuaDriverHost.ts";
import * as CuaInstallation from "./CuaInstallation.ts";
import { loadCuaSdk } from "./CuaSdkModule.ts";

export const layer = Layer.effect(
  CuaDriverHost.CuaEmbeddedSdk,
  Effect.gen(function* () {
    const installation = yield* CuaInstallation.CuaInstallation;
    return CuaDriverHost.CuaEmbeddedSdk.of({
      acquire: installation.acquire.pipe(
        Effect.mapError((cause) => new CuaDriverHost.CuaDriverError({ operation: "start", cause })),
        Effect.flatMap((binaryPath) =>
          Effect.try({
            try: () => new (loadCuaSdk().EmbeddedCuaDriverHost)(binaryPath, "codes.t3.windows"),
            catch: (cause) => new CuaDriverHost.CuaDriverError({ operation: "start", cause }),
          }),
        ),
      ),
    });
  }),
);

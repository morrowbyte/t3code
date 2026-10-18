import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Command } from "effect/cli";

const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const umlRenderCommand = Command.make("__uml-render").pipe(
  Command.unlisted,
  Command.withHandler(() =>
    Effect.gen(function* () {
      const result = yield* Effect.promise(async () => {
        let source = "";
        process.stdin.setEncoding("utf8");
        for await (const chunk of process.stdin) {
          source += String(chunk);
          if (source.length > 24_000) throw new Error("UML input exceeds its limit.");
        }
        const { runUmlRenderWorker } = await import("../streamable-ui/UmlRenderWorker.ts");
        return runUmlRenderWorker(source);
      });
      const output = yield* encodeResult(result);
      // The engine may write layout notices to stdout before its result.
      yield* Effect.sync(() => process.stdout.write(`\nT3_UML_RESULT:${output}`));
    }),
  ),
);

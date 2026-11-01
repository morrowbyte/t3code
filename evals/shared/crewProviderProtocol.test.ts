import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeCrewProviderClient, encodeCrewFrame } from "./crewProviderProtocol.ts";

it.effect.each([
  { line: undefined, code: "missing_bridge" },
  { line: "Please authenticate first", code: "missing_bridge" },
  { line: encodeCrewFrame({ type: "response", id: "request-2", response: {
    type: "complete", evaluationId: "eval-1", text: "done",
  } }).trimEnd(), code: "response_mismatch" },
])("rejects missing and unrelated host replies without an auth fallback: $code", ({ line, code }) =>
  Effect.gen(function* () {
    const writes: string[] = [];
    const client = makeCrewProviderClient(Effect.succeed(line), (outgoing) =>
      Effect.sync(() => { writes.push(outgoing); }));
    const error = yield* client.run({ action: "start", instructions: "Fixture", input: "Do it",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" }, tools: [] }).pipe(Effect.flip);
    expect(error.code).toBe(code);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"id":"request-1"');
    expect(writes[0]).not.toMatch(/credential|token|api_key/i);
  }),
);

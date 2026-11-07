import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { KIRO_MODEL_SWITCH_TARGET } from "./fixtures/kiro_model_switch/input.ts";
import { KIRO_MODEL_SELECTION } from "./fixtures/shared.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

it.effect("refreshes recorded runtime instructions without losing the switched model", () =>
  Effect.gen(function* () {
    const recorded = yield* readProviderReplayTranscript(
      new URL("./fixtures/kiro_model_switch/kiro_transcript.ndjson", import.meta.url),
    );
    const original = JSON.stringify(recorded);
    const replay = materializeReplayTranscriptRuntimeInstructions(recorded, {
      driver: ProviderDriverKind.make("kiro"),
      model: KIRO_MODEL_SELECTION.model,
    });
    const prompts = replay.entries.flatMap((entry) => {
      if (entry.type !== "expect_outbound") return [];
      const frame = entry.frame;
      if (
        typeof frame !== "object" ||
        frame === null ||
        !("method" in frame) ||
        frame.method !== "session/prompt" ||
        !("params" in frame) ||
        typeof frame.params !== "object" ||
        frame.params === null ||
        !("prompt" in frame.params) ||
        !Array.isArray(frame.params.prompt)
      ) {
        return [];
      }
      return [frame.params.prompt];
    });

    assert.equal(prompts.length, 2);
    assert.deepEqual(
      prompts.map((prompt) => prompt.at(-1)),
      [KIRO_MODEL_SELECTION.model, KIRO_MODEL_SWITCH_TARGET].map((model) => ({
        type: "text",
        text: buildRuntimeInstructions({ harness: "Kiro", model }),
      })),
    );
    assert.equal(JSON.stringify(recorded), original);
    assert.deepEqual(
      materializeReplayTranscriptRuntimeInstructions(replay, {
        driver: ProviderDriverKind.make("kiro"),
        model: KIRO_MODEL_SELECTION.model,
      }),
      replay,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

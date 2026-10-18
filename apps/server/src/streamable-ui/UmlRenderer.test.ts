import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { UmlRenderRequest } from "@t3tools/contracts";
import * as UmlRenderer from "./UmlRenderer.ts";

const palette = {
  background: "#0f1724",
  surface: "#172033",
  foreground: "#e5e7eb",
  muted: "#64748b",
  border: "#40506a",
  primary: "#60a5fa",
};
const examples: Array<[UmlRenderRequest["kind"], string]> = [
  [
    "sequence",
    "actor User\nparticipant API\nUser -> API: Start\nactivate API\nalt Ready\n API --> User: Data\nelse Pending\n loop Retry\n  API -> API: Check\n end\nend\ndeactivate API",
  ],
  [
    "class",
    "class Order {\n +id: UUID\n +total(): Money\n}\nclass Item\nOrder *-- Item\ninterface Store\nStore <|.. LocalStore",
  ],
  [
    "state",
    "[*] --> Ready\nstate Working {\n [*] --> Read\n Read --> Render: Record\n}\nReady --> Working: Start\nWorking --> [*]: Done",
  ],
  [
    "usecase",
    "actor User\nrectangle Portal {\n usecase Compare\n usecase Verify\n}\nUser -- Compare\nCompare ..> Verify: <<include>>",
  ],
  [
    "activity",
    "start\nif (Allowed?) then (yes)\n fork\n  :Read;\n fork again\n  :Verify;\n end fork\nelse (no)\n :Reject;\nendif\nstop",
  ],
];

it.effect(
  "renders all five UML notations privately with readable SVG and rejects external resources and mismatched diagram types",
  () =>
    Effect.gen(function* () {
      const renderer = yield* UmlRenderer.UmlRenderer;
      for (const [kind, body] of examples) {
        const result = yield* renderer.render({
          kind,
          source: `@startuml\n${body}\n@enduml`,
          palette,
        });
        expect(result.status, kind).toBe("ready");
        if (result.status === "ready") {
          expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
          expect(result.svg).toContain("background:#0f1724");
          expect(result.svg).not.toMatch(/<script|<image|<foreignObject|href=/i);
          expect(result.width).toBeGreaterThan(40);
          expect(result.height).toBeGreaterThan(40);
        }
      }
      expect(
        yield* renderer.render({
          kind: "state",
          source: "@startuml\nAlice -> Bob: Hello\n@enduml",
          palette,
        }),
      ).toEqual({ status: "unavailable", reason: "unsupported" });
      for (const source of [
        "!include https://example.com/private.puml",
        "Alice -> Bob: <img:https://example.com/image.png>",
      ]) {
        expect(
          yield* renderer.render({
            kind: "sequence",
            source: `@startuml\n${source}\n@enduml`,
            palette,
          }),
        ).toEqual({ status: "unavailable", reason: "unsupported" });
      }
    }).pipe(Effect.provide(UmlRenderer.layer)),
  20_000,
);

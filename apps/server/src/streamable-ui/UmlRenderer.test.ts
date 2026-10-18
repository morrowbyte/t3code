// @effect-diagnostics nodeBuiltinImport:off -- Exercises the installed Node entry and worker through real filesystem symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { UmlRenderRequest } from "@t3tools/contracts";
import * as UmlRenderer from "./UmlRenderer.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

const workers = vi.hoisted(() => ({ started: 0 }));
vi.mock(import("node:worker_threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        workers.started++;
      }
    },
  };
});

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

it.skipIf(!symlinksSupported)(
  "renders with the installed module when Node starts through an npm .bin symlink",
  async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-uml-bin-symlink-"));
    try {
      const packageRoot = NodePath.join(directory, "node_modules/t3");
      const dist = NodePath.join(packageRoot, "dist");
      const entry = NodePath.join(dist, "bin.mjs");
      const launcher = NodePath.join(directory, "node_modules/.bin/t3");
      await NodeFSP.mkdir(NodePath.join(dist, "streamable-ui"), { recursive: true });
      await NodeFSP.mkdir(NodePath.dirname(launcher), { recursive: true });
      await NodeFSP.symlink(
        NodeURL.fileURLToPath(new URL("../../node_modules", import.meta.url)),
        NodePath.join(packageRoot, "node_modules"),
        "junction",
      );
      const renderer = NodeModule.stripTypeScriptTypes(
        await NodeFSP.readFile(new URL("./UmlRenderer.ts", import.meta.url), "utf8"),
      );
      const worker = NodeModule.stripTypeScriptTypes(
        await NodeFSP.readFile(new URL("./UmlRenderWorker.ts", import.meta.url), "utf8"),
      );
      await NodeFSP.writeFile(NodePath.join(dist, "streamable-ui/UmlRenderWorker.mjs"), worker);
      const request = {
        kind: "sequence",
        source: "@startuml\nAlice -> Bob: Symlink\n@enduml",
        palette,
      };
      await NodeFSP.writeFile(
        entry,
        renderer +
          `\nconst result = await Effect.runPromise(Effect.gen(function* () {\n  const renderer = yield* UmlRenderer;\n  return yield* renderer.render(${JSON.stringify(request)});\n}).pipe(Effect.provide(layer)));\nconsole.log("T3_TEST_RESULT:" + JSON.stringify({ argv: process.argv[1], module: import.meta.url, result }));\n`,
      );
      await NodeFSP.symlink("../t3/dist/bin.mjs", launcher);
      const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
        process.execPath,
        [launcher],
        {
          cwd: directory,
        },
      );
      const line = stdout.split("\n").find((line) => line.startsWith("T3_TEST_RESULT:"));
      expect(line).toBeDefined();
      const output = JSON.parse(line!.slice("T3_TEST_RESULT:".length));
      expect(output.argv).toBe(launcher);
      expect(NodeURL.fileURLToPath(output.module)).toBe(await NodeFSP.realpath(entry));
      expect(output.result.status).toBe("ready");
      expect(output.result.svg).toContain("Alice");
      expect(output.result.svg).toContain("Bob");
      expect(output.result.width).toBeGreaterThan(40);
      expect(output.result.height).toBeGreaterThan(40);
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);

it.effect("renders identical queued UML requests in one worker and serves their cached SVG", () =>
  Effect.gen(function* () {
    const renderer = yield* UmlRenderer.UmlRenderer;
    const input = {
      kind: "sequence" as const,
      source: "@startuml\nAlice -> Bob: Queued\n@enduml",
      palette,
    };
    const before = workers.started;
    const results = yield* Effect.all(
      Array.from({ length: 4 }, () => renderer.render(input)),
      { concurrency: "unbounded" },
    );
    expect(results.every((result) => result.status === "ready")).toBe(true);
    expect(workers.started - before).toBe(1);
    expect(results).toEqual(Array.from({ length: 4 }, () => results[0]));
    expect(yield* renderer.render(input)).toEqual(results[0]);
    expect(workers.started - before).toBe(1);
  }).pipe(Effect.provide(UmlRenderer.layer)),
);

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

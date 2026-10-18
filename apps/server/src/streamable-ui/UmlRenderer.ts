import * as NodeWorkerThreads from "node:worker_threads";
import * as NodeSea from "node:sea";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- SEA rendering owns raw stdin/stdout and an interruptible child handle.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { SaxesParser } from "saxes";
import type { UmlRenderRequest, UmlRenderResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

export class UmlRenderer extends Context.Service<
  UmlRenderer,
  {
    readonly render: (input: UmlRenderRequest) => Effect.Effect<UmlRenderResult>;
  }
>()("t3/streamable-ui/UmlRenderer") {}

function prepareSource(input: UmlRenderRequest): string | null {
  const { source, palette: p } = input;
  // Only diagram notation crosses this boundary. Preprocessing, includes,
  // images and links can access resources outside the diagram itself.
  if (
    source.length > 16_000 ||
    source.split("\n").length > 256 ||
    /^\s*!|!\w+|%\w+\s*\(|\[\[|<(?:img|image|script|iframe|object|svg|style)\b|(?:https?|file|ftp|data|javascript):/im.test(
      source,
    ) ||
    /^\s*(?:skinparam|skin|scale|sprite|theme|pragma|newpage|header|footer|legend|caption|title)\b/im.test(
      source,
    )
  )
    return null;
  const lines = source.trim().split(/\r?\n/);
  if (
    lines[0]?.trim() !== "@startuml" ||
    lines.at(-1)?.trim() !== "@enduml" ||
    lines.slice(1, -1).some((line) => /^\s*@/.test(line))
  )
    return null;
  const style = `skinparam backgroundColor ${p.background}
skinparam defaultFontName sans-serif
skinparam defaultFontSize 14
skinparam defaultFontColor ${p.foreground}
skinparam shadowing false
skinparam roundcorner 10
skinparam ArrowColor ${p.muted}
skinparam LineThickness 1.5
skinparam ClassAttributeIconSize 0
skinparam BoxPadding 14
skinparam Padding 5
skinparam stateStartColor ${p.primary}
skinparam stateEndColor ${p.primary}
skinparam activityStartColor ${p.primary}
skinparam activityEndColor ${p.primary}
skinparam activityBarColor ${p.muted}
skinparam classBackgroundColor ${p.surface}
skinparam classBorderColor ${p.border}
skinparam stateBackgroundColor ${p.surface}
skinparam stateBorderColor ${p.border}
skinparam activityBackgroundColor ${p.surface}
skinparam activityBorderColor ${p.border}
skinparam usecaseBackgroundColor ${p.surface}
skinparam usecaseBorderColor ${p.border}
skinparam actorBackgroundColor ${p.surface}
skinparam actorBorderColor ${p.primary}
skinparam rectangleBackgroundColor ${p.background}
skinparam rectangleBorderColor ${p.border}
skinparam sequenceParticipantBackgroundColor ${p.surface}
skinparam sequenceParticipantBorderColor ${p.border}
skinparam sequenceLifeLineBorderColor ${p.muted}
skinparam sequenceLifeLineBackgroundColor ${p.surface}
skinparam sequenceGroupBackgroundColor ${p.surface}
skinparam sequenceGroupBorderColor ${p.border}
skinparam sequenceGroupHeaderFontColor ${p.foreground}
skinparam sequenceGroupFontColor ${p.foreground}
<style>
participant {
 Padding 16
}
</style>`;
  return [
    "@startuml",
    style,
    input.kind === "class" ? "hide circle" : input.kind === "sequence" ? "hide footbox" : "",
    ...lines.slice(1, -1),
    "@enduml",
  ].join("\n");
}

const elements = new Set([
  "svg",
  "g",
  "defs",
  "clipPath",
  "rect",
  "line",
  "path",
  "polygon",
  "polyline",
  "circle",
  "ellipse",
  "text",
  "tspan",
  "title",
  "desc",
  "linearGradient",
  "stop",
]);
const attributes = new Set([
  "id",
  "xmlns",
  "version",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "x",
  "y",
  "x1",
  "y1",
  "x2",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "style",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "opacity",
  "clip-path",
  "clip-rule",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "lengthAdjust",
  "textLength",
  "dy",
  "dx",
  "offset",
  "stop-color",
  "stop-opacity",
]);
const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

function sanitizeSvg(
  svg: string,
  background: string,
): { svg: string; width: number; height: number } | null {
  if (svg.length > 1_000_000) return null;
  let result = "",
    width = 0,
    height = 0,
    depth = 0,
    count = 0;
  try {
    const parser = new SaxesParser();
    parser.on("doctype", () => {
      throw new Error("doctype");
    });
    parser.on("error", () => {
      throw new Error("xml");
    });
    parser.on("opentag", (tag) => {
      if (
        !elements.has(tag.name) ||
        ++count > 15_000 ||
        depth++ > 64 ||
        (depth === 1 && tag.name !== "svg")
      )
        throw new Error("element");
      const safe: Array<[string, string]> = [];
      for (const [name, value] of Object.entries(tag.attributes)) {
        if (!attributes.has(name)) continue;
        if (name === "xmlns" && value !== "http://www.w3.org/2000/svg")
          throw new Error("namespace");
        if (
          /(?:javascript|data|https?|file):|expression\s*\(|@import|[<>]/i.test(value) &&
          name !== "xmlns"
        )
          throw new Error("resource");
        if (/url\(/i.test(value) && !/^url\(#[\w-]+\)$/.test(value)) throw new Error("resource");
        if (depth === 1 && name === "style") continue;
        safe.push([name, value]);
      }
      if (depth === 1) {
        const box = String(tag.attributes.viewBox ?? "")
          .trim()
          .split(/[ ,]+/)
          .map(Number);
        width = box[2] ?? 0;
        height = box[3] ?? 0;
        if (
          box.length !== 4 ||
          box.some((v) => !Number.isFinite(v)) ||
          width <= 0 ||
          height <= 0 ||
          width > 8192 ||
          height > 8192 ||
          width * height > 16_000_000
        )
          throw new Error("size");
        safe.push(["style", `background:${background}`]);
      }
      result += `<${tag.name}${safe.map(([name, value]) => ` ${name}="${escapeXml(value)}"`).join("")}>`;
    });
    parser.on("text", (value) => {
      result += escapeXml(value);
    });
    parser.on("closetag", (tag) => {
      depth--;
      result += `</${tag.name}>`;
    });
    parser.write(svg).close();
    return width > 0 && height > 0 ? { svg: result, width, height } : null;
  } catch {
    return null;
  }
}

function renderIsolated(source: string) {
  return Effect.callback<unknown>((resume) => {
    // SEA has no sibling Node script; its hidden command reads source on stdin.
    // Diagram text never appears in argv or process listings.
    if (NodeSea.isSea()) {
      const child = NodeChildProcess.spawn(process.execPath, ["__uml-render"], {
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.length > 1_100_000) {
          child.kill();
          resume(Effect.succeed(null));
        }
      });
      child.once("error", () => resume(Effect.succeed(null)));
      child.once("close", () => {
        try {
          const marker = "\nT3_UML_RESULT:";
          const start = output.lastIndexOf(marker);
          resume(
            Effect.succeed(start < 0 ? null : JSON.parse(output.slice(start + marker.length))),
          );
        } catch {
          resume(Effect.succeed(null));
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(source);
      return Effect.sync(() => {
        child.kill();
      });
    }
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "mjs";
    const base =
      extension === "ts" ? import.meta.url : NodeURL.pathToFileURL(process.argv[1]!).href;
    const url = new URL(
      extension === "ts" ? "./UmlRenderWorker.ts" : "./streamable-ui/UmlRenderWorker.mjs",
      base,
    );
    const worker = new NodeWorkerThreads.Worker(url, {
      workerData: { uml: true, source },
      resourceLimits: { maxOldGenerationSizeMb: 192 },
      execArgv: [],
    });
    // Node --watch also sends dependency notifications through this channel.
    worker.on("message", (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "type" in value &&
        value.type === "t3:uml-rendered" &&
        "result" in value
      )
        resume(Effect.succeed(value.result));
    });
    worker.once("error", (error) =>
      resume(
        Effect.logWarning("UML worker failed", {
          workerError: error.name,
          workerCode: "code" in error ? String(error.code) : "unknown",
        }).pipe(Effect.as(null)),
      ),
    );
    worker.once("exit", () => resume(Effect.succeed(null)));
    return Effect.promise(() => worker.terminate());
  });
}

const make = Effect.gen(function* () {
  const cache = new Map<string, Extract<UmlRenderResult, { status: "ready" }>>();
  const gate = yield* Semaphore.make(1);
  let pending = 0;
  const render = Effect.fn("UmlRenderer.render")(function* (input: UmlRenderRequest) {
    const source = prepareSource(input);
    if (source === null) return { status: "unavailable", reason: "unsupported" } as const;
    const key = `${input.kind}\0${source}`;
    const cached = cache.get(key);
    if (cached) return cached;
    if (pending >= 8) return { status: "unavailable", reason: "busy" } as const;
    pending++;
    return yield* Effect.gen(function* () {
      const result = yield* renderIsolated(source).pipe(Effect.timeoutOption("6 seconds"));
      if (result._tag === "None") return { status: "unavailable", reason: "timeout" } as const;
      const raw = result.value;
      if (
        typeof raw !== "object" ||
        raw === null ||
        !("valid" in raw) ||
        raw.valid !== true ||
        !("svg" in raw) ||
        typeof raw.svg !== "string"
      )
        return { status: "unavailable", reason: "invalid" } as const;
      // PlantUML reports use-case as DescriptionDiagram; require its actual
      // actor/usecase notation too, never silently accept a generic flowchart.
      const diagramTypes = {
        sequence: "SequenceDiagram",
        class: "ClassDiagram",
        state: "StateDiagram",
        usecase: "DescriptionDiagram",
        activity: "ActivityDiagram3",
      };
      if (
        !("diagramType" in raw) ||
        raw.diagramType !== diagramTypes[input.kind] ||
        (input.kind === "usecase" && !/\b(?:usecase|actor)\b|\([^\n]+\)/i.test(input.source))
      )
        return { status: "unavailable", reason: "unsupported" } as const;
      const safe = sanitizeSvg(raw.svg, input.palette.background);
      if (!safe) return { status: "unavailable", reason: "render_failed" } as const;
      const ready = { status: "ready", ...safe } as const;
      cache.set(key, ready);
      while (
        cache.size > 24 ||
        [...cache.values()].reduce((sum, value) => sum + value.svg.length, 0) > 4_000_000
      )
        cache.delete(cache.keys().next().value!);
      return ready;
    }).pipe(
      gate.withPermits(1),
      Effect.ensuring(
        Effect.sync(() => {
          pending--;
        }),
      ),
    );
  });
  return UmlRenderer.of({ render });
});
export const layer = Layer.effect(UmlRenderer, make);

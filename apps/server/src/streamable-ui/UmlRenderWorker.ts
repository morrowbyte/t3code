import * as NodeWorkerThreads from "node:worker_threads";
// @ts-expect-error -- The official TeaVM engine publishes JavaScript without declarations.
import { renderSvg } from "@plantuml/mcp-js/engine.js";

export async function runUmlRenderWorker(source: string): Promise<unknown> {
  const raw = await new Promise<string>((resolve) => renderSvg(source, resolve));
  return JSON.parse(raw);
}

if (!NodeWorkerThreads.isMainThread && NodeWorkerThreads.workerData?.uml === true) {
  try {
    NodeWorkerThreads.parentPort?.postMessage({
      type: "t3:uml-rendered",
      result: await runUmlRenderWorker(NodeWorkerThreads.workerData.source),
    });
  } catch {
    NodeWorkerThreads.parentPort?.postMessage({
      type: "t3:uml-rendered",
      result: { valid: false },
    });
  }
}

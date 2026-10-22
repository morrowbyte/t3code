// WinDev has Node but no usable Python. This client has no execute/approve operation.
import fs from "node:fs";
import process from "node:process";
import { createHash } from "node:crypto";

const [configFile, packageFile, outputFile, operation = "submit"] = process.argv.slice(2);
if (!configFile || !packageFile || !outputFile || !["submit", "read"].includes(operation)) {
  throw new Error(
    "usage: node request.mjs config.json package.json new-receipt.json [submit|read]",
  );
}
const scriptStartedAt = new Date().toISOString();
const clockStarted = performance.now();
const trace = fs.openSync(`${outputFile}.trace.jsonl`, "wx", 0o600);
const mark = (event, detail = {}) => {
  fs.writeSync(
    trace,
    `${JSON.stringify({ event, at: new Date().toISOString(), elapsedMs: performance.now() - clockStarted, ...detail })}\n`,
  );
  fs.fsyncSync(trace);
};
try {
  mark("script_started", {
    scriptStartedAt,
    modelDurationMs: null,
    modelTiming: "not_measured_by_requester",
  });
  const config = JSON.parse(fs.readFileSync(configFile, "utf8").replace(/^\uFEFF/, ""));
  mark("original_test_prompt", {
    promptAt: config.originalTestPromptAt ?? null,
    provenance: config.promptTimestampProvenance ?? "unavailable",
  });
  const url = new URL(config.authorityUrl);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("invalid_authority_url");
  }
  const privateHttp = /^(127\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && config.allowPrivateHttp === true && privateHttp)
  ) {
    throw new Error("tls_required");
  }
  const packageBytes = fs.readFileSync(packageFile);
  const payload = JSON.parse(packageBytes.toString("utf8").replace(/^\uFEFF/, ""));
  mark("action_data_ready");
  mark("frozen_input_ready", {
    inputSha256: createHash("sha256").update(packageBytes).digest("hex"),
    packageHash: null,
  });
  const token = fs.readFileSync(config.tokenFile, "utf8").trim();
  mark("http_submit_start", { operation });
  const response = await fetch(new URL(`/api/approval-review/${operation}`, url), {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  mark("http_submit_response", { status: response.status });
  if (!response.ok) throw new Error(`authority_http_${response.status}`);
  const result = await response.json();
  mark("server_hash_ready", {
    packageHash: result.authority.packageHash,
    state: result.authority.state,
  });
  const fd = fs.openSync(outputFile, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(result, null, 2), "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  console.log(
    JSON.stringify({
      threadId: result.threadId,
      requestId: result.requestId,
      packageHash: result.authority.packageHash,
      state: result.authority.state,
    }),
  );
  mark("receipt_saved", { outputFile });
} catch (error) {
  mark("failed", {
    error: error.name,
    message: error.message,
    causeCode: error.cause?.code ?? null,
  });
  throw error;
} finally {
  fs.closeSync(trace);
}

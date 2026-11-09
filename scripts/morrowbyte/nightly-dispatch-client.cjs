"use strict";

const fs = require("node:fs");
const nightlyAfterCI = require("./nightly-after-ci.cjs");

const API = "https://api.github.com";
const REPOSITORY = "morrowbyte/t3code";
const REPOSITORY_ID = 1175532637;
const MAX_PAGES = 100;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
const segment = (value) => encodeURIComponent(String(value));

function failure(message, status) {
  const error = new Error(message);
  if (status !== undefined) error.status = status;
  return error;
}

async function readBounded(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw failure("github-response-too-large");
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw failure("github-response-too-large");
      }
      chunks.push(Buffer.from(value));
    }
  }
  return Buffer.concat(chunks);
}

/** Only the REST surface used by the reviewed dispatch and source-proof helpers. */
function createGitHubClient({ token, fetchImpl = globalThis.fetch }) {
  if (typeof token !== "string" || !token || /[\r\n]/.test(token)) {
    throw failure("github-token-required");
  }
  async function request(url, { method = "GET", body, binary = false } = {}) {
    for (let redirects = 0; ; redirects++) {
      const destination = new URL(url);
      const authenticated = destination.origin === API;
      const artifactHost =
        destination.hostname.endsWith(".blob.core.windows.net") ||
        destination.hostname.endsWith(".actions.githubusercontent.com");
      if (
        destination.protocol !== "https:" ||
        destination.username ||
        destination.password ||
        destination.port ||
        (!authenticated && (!binary || !artifactHost))
      )
        throw failure("github-unsafe-redirect");
      let response;
      try {
        response = await fetchImpl(destination.href, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "morrowbyte-nightly-dispatch",
            ...(authenticated
              ? { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" }
              : {}),
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // Fetch errors can contain signed URLs or other transport details.
        throw failure("github-request-failed");
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!binary || method !== "GET" || !location || redirects >= 4) {
          throw failure("github-unexpected-redirect", response.status);
        }
        try {
          url = new URL(location, destination).href;
        } catch {
          throw failure("github-unsafe-redirect");
        }
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw failure(`github-http-${response.status}`, response.status);
      }
      const bytes = await readBounded(response, binary ? MAX_ARCHIVE_BYTES : MAX_JSON_BYTES);
      let data = null;
      if (binary) data = bytes;
      else if (bytes.length) {
        try {
          data = JSON.parse(bytes.toString("utf8"));
        } catch {
          throw failure("github-invalid-json");
        }
      }
      return { data, headers: response.headers };
    }
  }
  const route =
    (method, path, { query = [], body = [], binary = false } = {}) =>
    (input) => {
      if (`${input.owner}/${input.repo}` !== REPOSITORY)
        throw failure("github-repository-mismatch");
      const url = new URL(`/repos/${REPOSITORY}/${path(input)}`, API);
      for (const key of query)
        if (input[key] !== undefined) url.searchParams.set(key, String(input[key]));
      return request(url.href, {
        method,
        binary,
        ...(method === "GET"
          ? {}
          : {
              body: Object.fromEntries(
                body.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]),
              ),
            }),
      });
    };
  const rest = {
    actions: {
      getWorkflowRun: route("GET", (p) => `actions/runs/${segment(p.run_id)}`),
      listJobsForWorkflowRunAttempt: route(
        "GET",
        (p) => `actions/runs/${segment(p.run_id)}/attempts/${segment(p.attempt_number)}/jobs`,
        { query: ["per_page"] },
      ),
      listWorkflowRuns: route("GET", (p) => `actions/workflows/${segment(p.workflow_id)}/runs`, {
        query: ["head_sha", "branch", "event", "per_page"],
      }),
      listWorkflowRunArtifacts: route("GET", (p) => `actions/runs/${segment(p.run_id)}/artifacts`, {
        query: ["per_page"],
      }),
      downloadArtifact: (p) => {
        if (p.archive_format !== "zip") throw failure("github-unsupported-archive-format");
        return route("GET", (input) => `actions/artifacts/${segment(input.artifact_id)}/zip`, {
          binary: true,
        })(p);
      },
      createWorkflowDispatch: route(
        "POST",
        (p) => `actions/workflows/${segment(p.workflow_id)}/dispatches`,
        { body: ["ref", "inputs"] },
      ),
    },
    git: {
      getRef: route("GET", (p) => `git/ref/${p.ref.split("/").map(segment).join("/")}`),
    },
    repos: {
      getCommit: route("GET", (p) => `commits/${segment(p.ref)}`),
      getContent: route("GET", (p) => `contents/${p.path.split("/").map(segment).join("/")}`, {
        query: ["ref"],
      }),
      listCommitStatusesForRef: route("GET", (p) => `commits/${segment(p.ref)}/statuses`, {
        query: ["per_page"],
      }),
      listReleases: route("GET", () => "releases", { query: ["per_page"] }),
      createCommitStatus: route("POST", (p) => `statuses/${segment(p.sha)}`, {
        body: ["state", "context", "description", "target_url"],
      }),
    },
  };
  async function paginate(endpoint, input) {
    if (endpoint !== rest.repos.listReleases || input.per_page !== 100) {
      throw failure("github-unsupported-pagination");
    }
    let response = await endpoint(input);
    const base = new URL(`/repos/${REPOSITORY}/releases?per_page=100`, API);
    const results = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (!Array.isArray(response.data)) throw failure("github-invalid-release-page");
      results.push(...response.data);
      const link = response.headers.get("link");
      let next;
      for (const part of link ? link.split(/,\s*(?=<)/) : []) {
        const match = part.trim().match(/^<([^>]+)>;\s*rel="([a-z]+)"$/);
        if (!match) throw failure("github-invalid-pagination-link");
        if (match[2] === "next") {
          if (next) throw failure("github-invalid-pagination-link");
          next = match[1];
        }
      }
      if (!next) return results;
      const url = new URL(next, API);
      if (
        url.origin !== base.origin ||
        (url.pathname !== base.pathname &&
          url.pathname !== `/repositories/${REPOSITORY_ID}/releases`) ||
        url.username ||
        url.password ||
        url.hash ||
        url.searchParams.get("page") !== String(page + 1) ||
        url.searchParams.get("per_page") !== "100" ||
        [...url.searchParams].length !== 2
      )
        throw failure("github-unsafe-pagination-link");
      if (page === MAX_PAGES) throw failure("github-pagination-limit");
      response = await request(url.href);
    }
  }
  return { rest, paginate };
}

async function main({
  env = process.env,
  fetchImpl,
  dispatch = nightlyAfterCI,
  info = console.log,
} = {}) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY) throw failure("github-repository-mismatch");
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const github = createGitHubClient({ token, fetchImpl });
  const context = {
    repo: { owner: "morrowbyte", repo: "t3code" },
    payload: JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
  };
  const redact = (value) => String(value).split(token).join("[REDACTED]");
  const core = {
    info: (message) => info(redact(message)),
    setOutput(name, value) {
      const text = redact(value);
      if (!/^[a-z_]+$/.test(name) || /[\r\n]/.test(text) || !env.GITHUB_OUTPUT) {
        throw failure("github-invalid-output");
      }
      fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`);
    },
  };
  await dispatch({
    github,
    context,
    core,
    options: { runnerBackend: env.RELEASE_BACKEND || undefined },
  });
}

module.exports = { createGitHubClient, main };
if (require.main === module) {
  main().catch(() => {
    // Do not log arbitrary exception messages from HTTP, payloads, or signed URLs.
    console.error(
      "Nightly orchestration failed; inspect source qualification and any recorded dispatch intent before retrying.",
    );
    process.exitCode = 1;
  });
}

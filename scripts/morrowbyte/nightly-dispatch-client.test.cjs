"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createGitHubClient, main } = require("./nightly-dispatch-client.cjs");
const nightlyAfterCI = require("./nightly-after-ci.cjs");
const sourceProof = require("./source-proof.cjs");

const repo = { owner: "morrowbyte", repo: "t3code" };
const token = "synthetic-private-token";
const source = "a".repeat(40);
const json = (data, headers) => new Response(JSON.stringify(data), { headers });

test("maps the exact REST surface required by both unchanged helpers", async () => {
  const requests = [];
  const github = createGitHubClient({
    token,
    fetchImpl: async (url, options) => {
      requests.push({ url: new URL(url), options });
      return options.method === "POST" ? new Response(null, { status: 204 }) : json({ ok: true });
    },
  });
  const { actions, repos, git } = github.rest;
  const calls = [
    [actions.getWorkflowRun, { run_id: 1 }, "actions/runs/1"],
    [
      actions.listJobsForWorkflowRunAttempt,
      { run_id: 1, attempt_number: 2, per_page: 100 },
      "actions/runs/1/attempts/2/jobs",
      "?per_page=100",
    ],
    [
      actions.listWorkflowRuns,
      {
        workflow_id: "morrowbyte-release.yml",
        head_sha: source,
        branch: "main",
        event: "workflow_dispatch",
        per_page: 100,
      },
      "actions/workflows/morrowbyte-release.yml/runs",
      `?head_sha=${source}&branch=main&event=workflow_dispatch&per_page=100`,
    ],
    [
      actions.listWorkflowRunArtifacts,
      { run_id: 1, per_page: 100 },
      "actions/runs/1/artifacts",
      "?per_page=100",
    ],
    [
      actions.createWorkflowDispatch,
      { workflow_id: "morrowbyte-release.yml", ref: "main", inputs: { source_sha: source } },
      "actions/workflows/morrowbyte-release.yml/dispatches",
      "",
      { ref: "main", inputs: { source_sha: source } },
    ],
    [git.getRef, { ref: "heads/main" }, "git/ref/heads/main"],
    [repos.getCommit, { ref: source }, `commits/${source}`],
    [
      repos.getContent,
      { path: "scripts/morrowbyte/source-proof.cjs", ref: source },
      "contents/scripts/morrowbyte/source-proof.cjs",
      `?ref=${source}`,
    ],
    [
      repos.listCommitStatusesForRef,
      { ref: source, per_page: 100 },
      `commits/${source}/statuses`,
      "?per_page=100",
    ],
    [repos.listReleases, { per_page: 100 }, "releases", "?per_page=100"],
    [
      repos.createCommitStatus,
      {
        sha: source,
        state: "pending",
        context: "morrowbyte/nightly-dispatch",
        description: "intent",
        target_url: "https://github.com/morrowbyte/t3code/actions/runs/1",
      },
      `statuses/${source}`,
      "",
      {
        state: "pending",
        context: "morrowbyte/nightly-dispatch",
        description: "intent",
        target_url: "https://github.com/morrowbyte/t3code/actions/runs/1",
      },
    ],
  ];
  for (const [call, input, suffix, search = "", body] of calls) {
    const response = await call({ ...repo, ...input });
    assert.deepEqual(response.data, body ? null : { ok: true });
    const request = requests.at(-1);
    assert.equal(
      request.url.href,
      `https://api.github.com/repos/morrowbyte/t3code/${suffix}${search}`,
    );
    assert.equal(request.options.headers.Authorization, `Bearer ${token}`);
    assert.equal(request.options.redirect, "manual");
    assert.equal(request.options.method, body ? "POST" : "GET");
    assert.deepEqual(request.options.body ? JSON.parse(request.options.body) : undefined, body);
  }
  assert.equal(requests.length, calls.length);
  assert.throws(
    () => repos.getCommit({ ...repo, repo: "foreign", ref: source }),
    /repository-mismatch/,
  );
  assert.throws(
    () => actions.downloadArtifact({ ...repo, artifact_id: 1, archive_format: "tar" }),
    /unsupported-archive/,
  );
});

test("downloads binary proof archives without forwarding credentials to storage", async () => {
  const requests = [];
  const bytes = Buffer.from([0, 255, 0, 10, 127]);
  const github = createGitHubClient({
    token,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "https://proof.blob.core.windows.net/archive?sig=private" },
          })
        : new Response(bytes);
    },
  });
  const { data } = await github.rest.actions.downloadArtifact({
    ...repo,
    artifact_id: 42,
    archive_format: "zip",
  });
  assert.deepEqual(data, bytes);
  assert.equal(
    requests[0].url,
    "https://api.github.com/repos/morrowbyte/t3code/actions/artifacts/42/zip",
  );
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers["X-GitHub-Api-Version"], undefined);
});

test("preserves HTTP status and never retries failed or redirected mutations", async () => {
  for (const outcome of [403, 429, 500, 302, "network"]) {
    let calls = 0;
    const github = createGitHubClient({
      token,
      fetchImpl: async () => {
        calls++;
        if (outcome === "network") throw Error(`network contained ${token}`);
        return new Response(null, {
          status: outcome,
          headers: { location: "https://api.github.com/elsewhere" },
        });
      },
    });
    await assert.rejects(
      github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: "release.yml",
        ref: "main",
        inputs: {},
      }),
      (error) => {
        assert.equal(error.status, outcome === "network" ? undefined : outcome);
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("follows all release pages but rejects changed origins, paths, queries and cycles", async () => {
  const next = "https://api.github.com/repos/morrowbyte/t3code/releases?per_page=100&page=2";
  const requests = [];
  const github = createGitHubClient({
    token,
    fetchImpl: async (url) => {
      requests.push(url);
      return requests.length === 1
        ? json([{ id: 1 }], { link: `<${next}>; rel="next", <${next}>; rel="last"` })
        : json([{ id: 2 }], {
            link: '<https://api.github.com/repos/morrowbyte/t3code/releases?per_page=100&page=1>; rel="prev"',
          });
    },
  });
  assert.deepEqual(
    await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 }),
    [{ id: 1 }, { id: 2 }],
  );
  assert.equal(requests.length, 2);
  for (const location of [
    next.replace("api.github.com", "example.com"),
    next.replace("/repos/morrowbyte/t3code/", "/repositories/1175532638/"),
    next.replace("/releases?", "/statuses?"),
    next.replace("page=2", "page=1"),
    next + "&extra=1",
    "https://user:password@api.github.com/repos/morrowbyte/t3code/releases?per_page=100&page=2",
  ]) {
    let calls = 0;
    const client = createGitHubClient({
      token,
      fetchImpl: async () => {
        calls++;
        return json([], { link: `<${location}>; rel="next"` });
      },
    });
    await assert.rejects(
      client.paginate(client.rest.repos.listReleases, { ...repo, per_page: 100 }),
      /unsafe-pagination/,
    );
    assert.equal(calls, 1);
  }
});

test("follows GitHub's canonical numeric repository links across release pages", async () => {
  const requests = [];
  const github = createGitHubClient({
    token,
    fetchImpl: async (url) => {
      requests.push(url);
      const page = requests.length;
      return json(
        [{ id: page }],
        page < 3
          ? {
              link: `<https://api.github.com/repositories/1175532637/releases?per_page=100&page=${page + 1}>; rel="next"`,
            }
          : undefined,
      );
    },
  });
  assert.deepEqual(
    await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 }),
    [{ id: 1 }, { id: 2 }, { id: 3 }],
  );
  assert.deepEqual(requests, [
    "https://api.github.com/repos/morrowbyte/t3code/releases?per_page=100",
    "https://api.github.com/repositories/1175532637/releases?per_page=100&page=2",
    "https://api.github.com/repositories/1175532637/releases?per_page=100&page=3",
  ]);
});

test("bounds release pagination and rejects malformed pagination rather than hiding releases", async () => {
  let calls = 0;
  const github = createGitHubClient({
    token,
    fetchImpl: async () => {
      calls++;
      return json([], {
        link: `<https://api.github.com/repos/morrowbyte/t3code/releases?per_page=100&page=${calls + 1}>; rel="next"`,
      });
    },
  });
  await assert.rejects(
    github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 }),
    /pagination-limit/,
  );
  assert.equal(calls, 100);
  const malformed = createGitHubClient({
    token,
    fetchImpl: async () => json([], { link: "broken; rel=next" }),
  });
  await assert.rejects(
    malformed.paginate(malformed.rest.repos.listReleases, { ...repo, per_page: 100 }),
    /invalid-pagination/,
  );
});

test("rejects unsafe archive redirects, excessive data and invalid JSON", async () => {
  for (const location of [
    "http://proof.blob.core.windows.net/a",
    "https://example.com/a",
    "https://localhost/a",
    "https://user:pass@proof.blob.core.windows.net/a",
  ]) {
    let calls = 0;
    const github = createGitHubClient({
      token,
      fetchImpl: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { location } });
      },
    });
    await assert.rejects(
      github.rest.actions.downloadArtifact({ ...repo, artifact_id: 1, archive_format: "zip" }),
      /unsafe-redirect/,
    );
    assert.equal(calls, 1);
  }
  const oversized = createGitHubClient({
    token,
    fetchImpl: async () =>
      new Response(null, { headers: { "content-length": String(4 * 1024 * 1024 + 1) } }),
  });
  await assert.rejects(
    oversized.rest.actions.downloadArtifact({ ...repo, artifact_id: 1, archive_format: "zip" }),
    /too-large/,
  );
  const invalid = createGitHubClient({ token, fetchImpl: async () => new Response("not json") });
  await assert.rejects(invalid.rest.repos.getCommit({ ...repo, ref: source }), /invalid-json/);
});

test("the unchanged source-proof helper consumes the client's binary response", async () => {
  const expected = {
    sourceSha: source,
    baseSha: "b".repeat(40),
    files: Object.fromEntries(sourceProof.FILES.map((file) => [file, "hash"])),
    toolchain: { node: "26.12.1", vitePlus: "1.0.0" },
  };
  const proof = {
    schemaVersion: 1,
    status: "success",
    complete: true,
    profile: sourceProof.PROFILE,
    ...expected,
    groups: sourceProof.GROUPS.map((name) => ({ name, status: "success" })),
    environment: {
      platform: "linux",
      arch: "x64",
      runnerLabel: "boat-large",
      node: "26.12.1",
      vitePlus: "1.0.0",
      python: "Python 3.13",
      bash: "GNU bash, version 5.3",
    },
    producer: {
      repository: "morrowbyte/t3code",
      runId: 42,
      attempt: 1,
      contextSha: source,
      workflowSha: source,
      workflowRef: `morrowbyte/t3code/${sourceProof.WORKFLOW}@refs/heads/main`,
    },
  };
  const archive = execFileSync(
    "python3",
    [
      "-c",
      "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w'); z.writestr('source-proof.json',sys.stdin.buffer.read()); z.close(); sys.stdout.buffer.write(b.getvalue())",
    ],
    { input: JSON.stringify(proof) },
  );
  const run = {
    id: 42,
    run_attempt: 1,
    repository: { full_name: "morrowbyte/t3code" },
    head_repository: { full_name: "morrowbyte/t3code" },
    path: sourceProof.WORKFLOW,
    event: "workflow_dispatch",
    head_sha: source,
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const artifact = {
    id: 9,
    name: sourceProof.artifactName(source, 1),
    expired: false,
    workflow_run: { id: 42, head_sha: source },
    digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
  };
  const github = createGitHubClient({
    token,
    fetchImpl: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/runs/42")) return json(run);
      if (pathname.endsWith("/attempts/1/jobs"))
        return json({
          total_count: 1,
          jobs: [
            { name: "check", status: "completed", conclusion: "success", labels: ["boat-large"] },
          ],
        });
      if (pathname.endsWith("/runs/42/artifacts"))
        return json({ total_count: 1, artifacts: [artifact] });
      if (pathname.endsWith("/artifacts/9/zip")) return new Response(archive);
      throw Error("unexpected test request");
    },
  });
  const result = await sourceProof.verifySourceProof({ github, repo, source, runId: 42, expected });
  assert.equal(result.artifactDigest, artifact.digest);
  assert.deepEqual(result.proof, proof);
});

test("CLI context and outputs work with the unchanged helper's reconciliation path", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-client-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  const output = path.join(directory, "output");
  const run = {
    id: 1,
    run_attempt: 1,
    repository: { full_name: "morrowbyte/t3code" },
    head_repository: { full_name: "morrowbyte/t3code" },
    head_sha: source,
    head_branch: "main",
    path: ".github/workflows/morrowbyte-ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: run }));
  const requests = [];
  const messages = [];
  await main({
    env: {
      GH_TOKEN: token,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: "morrowbyte/t3code",
      GITHUB_OUTPUT: output,
      RELEASE_BACKEND: "boat",
    },
    info: (message) => messages.push(message),
    fetchImpl: async (url, options) => {
      const pathname = new URL(url).pathname;
      requests.push({ pathname, options });
      if (pathname.endsWith("/runs/1")) return json(run);
      if (pathname.endsWith("/attempts/1/jobs"))
        return json({
          total_count: 1,
          jobs: [{ name: "check", status: "completed", conclusion: "success" }],
        });
      if (pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: source } });
      if (pathname.endsWith("/statuses") && options.method === "GET") return json([]);
      if (pathname.endsWith("/morrowbyte-release.yml/runs"))
        return json({
          total_count: 1,
          workflow_runs: [
            {
              id: 2,
              head_sha: source,
              head_branch: "main",
              path: ".github/workflows/morrowbyte-release.yml",
              event: "workflow_dispatch",
              html_url: "https://github.com/morrowbyte/t3code/actions/runs/2",
            },
          ],
        });
      if (pathname.endsWith("/releases")) return json([]);
      if (pathname.endsWith(`/statuses/${source}`)) return json({});
      throw Error("unexpected test request");
    },
  });
  assert.equal(requests.filter(({ options }) => options.method === "POST").length, 1);
  assert.equal(
    requests.some(({ pathname }) => pathname.endsWith("/dispatches")),
    false,
  );
  assert.equal(fs.readFileSync(output, "utf8"), `nightly_run_id=2\nsource_sha=${source}\n`);
  assert.equal(messages.join(" ").includes(token), false);
  await assert.rejects(main({ env: { GITHUB_REPOSITORY: "foreign/repo" } }), /repository-mismatch/);
  await assert.rejects(main({ env: { GITHUB_REPOSITORY: "morrowbyte/t3code" } }), /token-required/);
});

test("an existing unresolved dispatch intent still prevents any mutation", async () => {
  const run = {
    id: 1,
    run_attempt: 1,
    repository: { full_name: "morrowbyte/t3code" },
    head_repository: { full_name: "morrowbyte/t3code" },
    head_sha: source,
    head_branch: "main",
    path: ".github/workflows/morrowbyte-ci.yml",
    event: "push",
    status: "completed",
    conclusion: "success",
  };
  const methods = [];
  const github = createGitHubClient({
    token,
    fetchImpl: async (url, options) => {
      methods.push(options.method);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/runs/1")) return json(run);
      if (pathname.endsWith("/attempts/1/jobs"))
        return json({
          total_count: 1,
          jobs: [{ name: "check", status: "completed", conclusion: "success" }],
        });
      if (pathname.endsWith("/git/ref/heads/main")) return json({ object: { sha: source } });
      if (pathname.endsWith("/statuses"))
        return json([{ context: "morrowbyte/nightly-dispatch", state: "pending" }]);
      if (pathname.endsWith("/morrowbyte-release.yml/runs"))
        return json({ total_count: 0, workflow_runs: [] });
      if (pathname.endsWith("/releases")) return json([]);
      throw Error("unexpected test request");
    },
  });
  await assert.rejects(
    nightlyAfterCI({ github, context: { repo, payload: { workflow_run: run } }, core: {} }),
    /existing-intent-without-reconciled-run/,
  );
  assert.ok(methods.length > 0);
  assert.ok(methods.every((method) => method === "GET"));
});

test("CLI redacts the token and rejects multiline workflow outputs", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nightly-client-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, "event.json");
  const output = path.join(directory, "output");
  fs.writeFileSync(eventPath, "{}");
  const messages = [];
  const env = {
    GITHUB_TOKEN: token,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: "morrowbyte/t3code",
    GITHUB_OUTPUT: output,
    RELEASE_BACKEND: "boat",
  };
  await main({
    env,
    info: (message) => messages.push(message),
    dispatch: async ({ core, options }) => {
      assert.equal(options.runnerBackend, "boat");
      core.info(`Never log ${token}`);
      core.setOutput("source_sha", token);
      assert.throws(() => core.setOutput("source_sha", "first\nsecond"), /invalid-output/);
    },
  });
  assert.deepEqual(messages, ["Never log [REDACTED]"]);
  assert.equal(fs.readFileSync(output, "utf8"), "source_sha=[REDACTED]\n");
});

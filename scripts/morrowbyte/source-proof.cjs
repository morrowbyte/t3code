"use strict";
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPOSITORY = "morrowbyte/t3code";
const WORKFLOW = ".github/workflows/morrowbyte-local-source-check.yml";
const RUNNER_LABEL = "boat-large";
const PROFILE = "morrowbyte-check-full-v1";
const GROUPS = [
  "licenses",
  "dispatch-and-recovery",
  "shell-and-nix-updater",
  "packaging-tests",
  "route-generation",
  "typecheck",
  "mobile-composer-lint",
  "node-tests",
  "mobile-tests",
  "terminal-tests",
  "browser-tests",
];
const FILES = [
  "pnpm-lock.yaml",
  "package.json",
  "pnpm-workspace.yaml",
  "scripts/morrowbyte/check.sh",
  "scripts/morrowbyte/test.sh",
  "scripts/morrowbyte/source-proof.cjs",
  "scripts/morrowbyte/nightly-after-ci.cjs",
  WORKFLOW,
  ".github/workflows/morrowbyte-main-nightly.yml",
  ".github/actions/setup-ci-deps/action.yml",
];
const ROUTE_FILES = ["receipt.json", "routeTree.gen.ts", "routeTree.diff"];
const assert = (ok, reason) => {
  if (!ok) throw Error(reason);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const isSha = (value) => /^[0-9a-f]{40}$/.test(value ?? "");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const artifactName = (source, attempt) => `morrowbyte-source-proof-${source}-${attempt}`;

function sourceIdentity(read, sourceSha, baseSha) {
  assert(isSha(sourceSha) && isSha(baseSha), "invalid-source-proof-shas");
  const files = Object.fromEntries(FILES.map((file) => [file, sha256(read(file))]));
  const node = JSON.parse(read("package.json")).engines.node;
  const vitePlus = String(read("pnpm-workspace.yaml")).match(/^  vite-plus: ([^\s]+)$/m)?.[1];
  assert(
    /^\d+\.\d+\.\d+$/.test(node) && /^\d+\.\d+\.\d+$/.test(vitePlus),
    "unpinned-source-toolchain",
  );
  return { sourceSha, baseSha, files, toolchain: { node, vitePlus } };
}

function validateReceipt(proof, expected, run) {
  assert(
    proof?.schemaVersion === 1 && proof.status === "success" && proof.complete === true,
    "source-proof-not-complete",
  );
  assert(proof.profile === PROFILE, "source-proof-not-full-profile");
  assert(proof.sourceSha === expected.sourceSha, "source-proof-sha-mismatch");
  assert(proof.baseSha === expected.baseSha, "source-proof-base-mismatch");
  assert(
    Object.keys(proof.files ?? {}).length === FILES.length &&
      FILES.every((file) => proof.files[file] === expected.files[file]),
    "source-proof-program-or-lock-mismatch",
  );
  assert(
    Array.isArray(proof.groups) &&
      proof.groups.length === GROUPS.length &&
      GROUPS.every(
        (name, index) =>
          proof.groups[index]?.name === name && proof.groups[index]?.status === "success",
      ),
    "source-proof-group-incomplete",
  );
  assert(
    proof.environment?.platform === "linux" &&
      proof.environment.arch === "x64" &&
      proof.environment.runnerLabel === RUNNER_LABEL &&
      proof.environment.node === expected.toolchain.node &&
      proof.environment.vitePlus === expected.toolchain.vitePlus &&
      /^Python 3\./.test(proof.environment.python ?? "") &&
      /^GNU bash, version 5\./.test(proof.environment.bash ?? ""),
    "source-proof-environment-mismatch",
  );
  assert(
    proof.producer?.repository === REPOSITORY &&
      proof.producer.runId === run.id &&
      proof.producer.attempt === run.run_attempt &&
      proof.producer.contextSha === expected.sourceSha &&
      proof.producer.workflowSha === expected.sourceSha &&
      proof.producer.workflowRef === `${REPOSITORY}/${WORKFLOW}@refs/heads/${run.head_branch}`,
    "source-proof-producer-mismatch",
  );
  return proof;
}

function validateProvenance(run, jobs, artifact, source) {
  assert(
    run?.repository?.full_name === REPOSITORY &&
      run.head_repository?.full_name === REPOSITORY &&
      run.path === WORKFLOW &&
      run.event === "workflow_dispatch" &&
      run.head_sha === source &&
      run.status === "completed" &&
      run.conclusion === "success" &&
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      Number.isSafeInteger(run.run_attempt) &&
      run.run_attempt > 0,
    "source-proof-run-not-successful",
  );
  assert(
    jobs?.total_count === 1 &&
      jobs.jobs?.length === 1 &&
      jobs.jobs[0].name === "check" &&
      jobs.jobs[0].status === "completed" &&
      jobs.jobs[0].conclusion === "success" &&
      jobs.jobs[0].labels?.includes(RUNNER_LABEL),
    "source-proof-job-or-runner-mismatch",
  );
  assert(
    artifact?.name === artifactName(source, run.run_attempt) &&
      artifact.expired === false &&
      Number.isSafeInteger(artifact.id) &&
      artifact.id > 0 &&
      artifact.workflow_run?.id === run.id &&
      artifact.workflow_run?.head_sha === source &&
      /^sha256:[0-9a-f]{64}$/.test(artifact.digest ?? ""),
    "source-proof-artifact-provenance-missing",
  );
}

async function readSourceIdentity(github, repo, source) {
  const { data: commit } = await github.rest.repos.getCommit({ ...repo, ref: source });
  assert(commit.sha === source && isSha(commit.parents?.[0]?.sha), "source-proof-base-unavailable");
  const entries = await Promise.all(
    FILES.map(async (file) => {
      const { data } = await github.rest.repos.getContent({ ...repo, path: file, ref: source });
      assert(
        data.type === "file" && data.encoding === "base64" && data.size <= 1024 * 1024,
        "source-proof-source-file-unavailable:" + file,
      );
      const bytes = Buffer.from(data.content, "base64");
      assert(bytes.length === data.size, "source-proof-source-file-incomplete:" + file);
      return [file, bytes];
    }),
  );
  const files = new Map(entries);
  return sourceIdentity((file) => files.get(file), source, commit.parents[0].sha);
}

function unpackArtifact(archive) {
  assert(archive.length > 0 && archive.length <= 4 * 1024 * 1024, "source-proof-archive-size");
  // Python is already required by check.sh and the Linux release preflight.
  const unpacked = execFileSync(
    "python3",
    [
      "-c",
      `
import base64, io, json, sys, zipfile
limits = {'source-proof.json': 65536, 'receipt.json': 65536, 'routeTree.gen.ts': 1048576, 'routeTree.diff': 2097152}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    names = archive.namelist()
    assert len(names) == len(set(names)) and 'source-proof.json' in names
    assert set(names) <= set(limits)
    assert all(archive.getinfo(name).file_size <= limits[name] for name in names)
    print(json.dumps({name: base64.b64encode(archive.read(name)).decode() for name in names}))
`,
    ],
    { input: archive, maxBuffer: 5 * 1024 * 1024 },
  );
  return Object.fromEntries(
    Object.entries(JSON.parse(unpacked)).map(([name, value]) => [
      name,
      Buffer.from(value, "base64"),
    ]),
  );
}

async function verifySourceProof({
  github,
  repo,
  source,
  runId,
  artifactId,
  artifactDigest,
  expected,
}) {
  assert(
    `${repo.owner}/${repo.repo}` === REPOSITORY && isSha(source),
    "invalid-source-proof-request",
  );
  if (!runId) {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...repo,
      workflow_id: path.basename(WORKFLOW),
      head_sha: source,
      event: "workflow_dispatch",
      per_page: 100,
    });
    assert(
      data.total_count > 0 &&
        data.total_count <= 100 &&
        data.workflow_runs.length === data.total_count,
      "source-proof-missing-or-ambiguous",
    );
    runId = Math.max(...data.workflow_runs.map((run) => run.id));
  }
  assert(
    /^[1-9][0-9]*$/.test(String(runId)) && Number.isSafeInteger(Number(runId)),
    "invalid-source-proof-run-id",
  );
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repo,
    run_id: Number(runId),
  });
  const [{ data: jobs }, { data: artifacts }] = await Promise.all([
    github.rest.actions.listJobsForWorkflowRunAttempt({
      ...repo,
      run_id: run.id,
      attempt_number: run.run_attempt,
      per_page: 100,
    }),
    github.rest.actions.listWorkflowRunArtifacts({ ...repo, run_id: run.id, per_page: 100 }),
  ]);
  assert(
    artifacts.total_count <= 100 && artifacts.artifacts.length === artifacts.total_count,
    "source-proof-artifact-window-incomplete",
  );
  const matches = artifacts.artifacts.filter(
    (artifact) => artifact.name === artifactName(source, run.run_attempt),
  );
  assert(matches.length === 1, "source-proof-artifact-missing-or-ambiguous");
  const artifact = matches[0];
  validateProvenance(run, jobs, artifact, source);
  if (artifactId !== undefined || artifactDigest !== undefined) {
    assert(
      String(artifact.id) === String(artifactId) && artifact.digest === artifactDigest,
      "source-proof-changed-since-dispatch",
    );
  }
  const { data } = await github.rest.actions.downloadArtifact({
    ...repo,
    artifact_id: artifact.id,
    archive_format: "zip",
  });
  const archive = Buffer.from(data);
  assert(`sha256:${sha256(archive)}` === artifact.digest, "source-proof-artifact-digest-mismatch");
  const files = unpackArtifact(archive);
  const identity = expected ?? (await readSourceIdentity(github, repo, source));
  const proof = validateReceipt(JSON.parse(files["source-proof.json"]), identity, run);
  if (proof.route) {
    assert(
      ROUTE_FILES.every((file) => files[file] && sha256(files[file]) === proof.route[file]),
      "source-proof-route-mismatch",
    );
    const receipt = JSON.parse(files["receipt.json"]);
    assert(
      receipt.status === "generated-unreviewed" &&
        receipt.source === source &&
        receipt.effectiveSourceSha === source &&
        receipt.trustedContextSha === source &&
        receipt.trustedWorkflowSha === source &&
        receipt.trustedWorkflowRef === proof.producer.workflowRef &&
        Number(receipt.run) === run.id &&
        Number(receipt.attempt) === run.run_attempt &&
        receipt.lockSha256 === identity.files["pnpm-lock.yaml"] &&
        receipt.checkScriptSha256 === identity.files["scripts/morrowbyte/check.sh"] &&
        receipt.afterSha256 === sha256(files["routeTree.gen.ts"]),
      "source-proof-route-producer-mismatch",
    );
  } else {
    assert(Object.keys(files).length === 1, "source-proof-unbound-route-files");
  }
  return { proof, files, runId: run.id, artifactId: artifact.id, artifactDigest: artifact.digest };
}

function produce(command, group) {
  const filename = process.env.MORROWBYTE_SOURCE_PROOF;
  assert(filename && path.isAbsolute(filename), "source-proof-output-required");
  if (command === "begin") {
    assert(!fs.existsSync(filename), "source-proof-output-already-exists");
    assert(
      git("status", "--porcelain", "--untracked-files=all") === "",
      "source-proof-dirty-checkout",
    );
    const source = git("rev-parse", "HEAD");
    const base = git("rev-parse", "HEAD^1");
    assert(
      source === process.env.EFFECTIVE_SOURCE_SHA && base === process.env.SOURCE_BASE_SHA,
      "source-proof-checkout-or-base-mismatch",
    );
    assert(
      process.env.GITHUB_SHA === source &&
        process.env.GITHUB_WORKFLOW_SHA === source &&
        process.env.GITHUB_REPOSITORY === REPOSITORY &&
        process.env.GITHUB_EVENT_NAME === "workflow_dispatch",
      "source-proof-not-trusted-workflow",
    );
    assert(process.env.MORROWBYTE_SOURCE_RUNNER === RUNNER_LABEL, "source-proof-not-boat");
    const identity = sourceIdentity((file) => fs.readFileSync(file), source, base);
    const proof = {
      schemaVersion: 1,
      status: "running",
      complete: false,
      profile: PROFILE,
      ...identity,
      groups: [],
      producer: {
        repository: REPOSITORY,
        runId: Number(process.env.GITHUB_RUN_ID),
        attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        contextSha: process.env.GITHUB_SHA,
        workflowSha: process.env.GITHUB_WORKFLOW_SHA,
        workflowRef: process.env.GITHUB_WORKFLOW_REF,
      },
      environment: {
        // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone CI helper has no Effect runtime.
        platform: process.platform,
        // oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone CI helper has no Effect runtime.
        arch: process.arch,
        runnerLabel: process.env.MORROWBYTE_SOURCE_RUNNER,
        node: process.versions.node,
        vitePlus: JSON.parse(fs.readFileSync("node_modules/vite-plus/package.json")).version,
        python: execFileSync("python3", ["--version"], { encoding: "utf8" }).trim(),
        bash: execFileSync("bash", ["--version"], { encoding: "utf8" }).split("\n")[0],
      },
    };
    fs.writeFileSync(filename, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return;
  }
  const proof = JSON.parse(fs.readFileSync(filename));
  assert(proof.status === "running", "source-proof-already-finished");
  if (command === "group") {
    assert(GROUPS[proof.groups.length] === group, "source-proof-group-order");
    proof.groups.push({ name: group, status: "success" });
  } else {
    assert(command === "complete", "invalid-source-proof-command");
    const changes = git("diff", "--name-only", "HEAD").split("\n").filter(Boolean);
    const routePath = "apps/web/src/routeTree.gen.ts";
    assert(
      changes.every((file) => file === routePath) &&
        !git("ls-files", "--others", "--exclude-standard"),
      "source-proof-source-changed",
    );
    assert(git("rev-parse", "HEAD") === proof.sourceSha, "source-proof-head-changed");
    const routeDirectory = path.join(process.env.RUNNER_TEMP, "observatory-route-generation");
    if (fs.existsSync("apps/web/src/routes/observatory.tsx")) {
      proof.route = Object.fromEntries(
        ROUTE_FILES.map((file) => {
          const bytes = fs.readFileSync(path.join(routeDirectory, file));
          if (file === "routeTree.gen.ts")
            assert(
              sha256(bytes) === sha256(fs.readFileSync(routePath)),
              "source-proof-route-changed",
            );
          fs.writeFileSync(path.join(path.dirname(filename), file), bytes, {
            flag: "wx",
            mode: 0o600,
          });
          return [file, sha256(bytes)];
        }),
      );
    } else assert(changes.length === 0, "source-proof-unexpected-route");
    proof.status = "success";
    proof.complete = true;
    validateReceipt(
      proof,
      sourceIdentity((file) => fs.readFileSync(file), proof.sourceSha, git("rev-parse", "HEAD^1")),
      {
        id: Number(process.env.GITHUB_RUN_ID),
        run_attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
        head_branch: process.env.GITHUB_REF_NAME,
      },
    );
  }
  const temporary = filename + ".tmp";
  fs.writeFileSync(temporary, JSON.stringify(proof, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  fs.renameSync(temporary, filename);
}

module.exports = {
  GROUPS,
  FILES,
  PROFILE,
  WORKFLOW,
  RUNNER_LABEL,
  artifactName,
  sourceIdentity,
  validateReceipt,
  validateProvenance,
  verifySourceProof,
  readSourceIdentity,
  sha256,
};
if (require.main === module) produce(process.argv[2], process.argv[3]);

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const nightlyAfterCI = require("./nightly-after-ci.cjs");
const {
  GROUPS,
  PROFILE,
  WORKFLOW,
  RUNNER_LABEL,
  artifactName,
  sourceIdentity,
  validateReceipt,
  validateProvenance,
  verifySourceProof,
  sha256,
} = require("./source-proof.cjs");

const source = "a".repeat(40);
const base = "b".repeat(40);
const repo = { owner: "morrowbyte", repo: "t3code" };
const bytes = (file) =>
  Buffer.from(
    file === "package.json"
      ? JSON.stringify({ engines: { node: "26.12.1" } })
      : file === "pnpm-workspace.yaml"
        ? "catalog:\n  vite-plus: 0.1.0\n"
        : `frozen:${file}`,
  );
const expected = () => sourceIdentity(bytes, source, base);
const producerRun = () => ({
  id: 456,
  run_attempt: 2,
  head_sha: source,
  head_branch: "integration/frozen",
  repository: { full_name: "morrowbyte/t3code" },
  head_repository: { full_name: "morrowbyte/t3code" },
  path: WORKFLOW,
  event: "workflow_dispatch",
  status: "completed",
  conclusion: "success",
});
const receipt = () => ({
  schemaVersion: 1,
  status: "success",
  complete: true,
  profile: PROFILE,
  ...expected(),
  groups: GROUPS.map((name) => ({ name, status: "success" })),
  producer: {
    repository: "morrowbyte/t3code",
    runId: 456,
    attempt: 2,
    contextSha: source,
    workflowSha: source,
    workflowRef: `morrowbyte/t3code/${WORKFLOW}@refs/heads/integration/frozen`,
  },
  environment: {
    platform: "linux",
    arch: "x64",
    runnerLabel: RUNNER_LABEL,
    node: "26.12.1",
    vitePlus: "0.1.0",
    python: "Python 3.12.3",
    bash: "GNU bash, version 5.2.21",
  },
});
const jobs = () => ({
  total_count: 1,
  jobs: [{ name: "check", status: "completed", conclusion: "success", labels: [RUNNER_LABEL] }],
});
const artifact = () => ({
  id: 789,
  name: artifactName(source, 2),
  expired: false,
  workflow_run: { id: 456, head_sha: source },
  digest: `sha256:${"c".repeat(64)}`,
});

test("full successful source evidence binds identity, complete coverage and toolchain", () => {
  assert.equal(
    expected().files["scripts/morrowbyte/nightly-dispatch-client.cjs"],
    sha256(bytes("scripts/morrowbyte/nightly-dispatch-client.cjs")),
  );
  assert.equal(validateReceipt(receipt(), expected(), producerRun()).sourceSha, source);
  validateProvenance(producerRun(), jobs(), artifact(), source);
});

const invalidReceipts = [
  [
    "another dispatch client",
    (proof) => {
      proof.files["scripts/morrowbyte/nightly-dispatch-client.cjs"] = "d".repeat(64);
    },
  ],
  [
    "another SHA",
    (proof) => {
      proof.sourceSha = base;
    },
  ],
  [
    "another comparison base",
    (proof) => {
      proof.baseSha = source;
    },
  ],
  [
    "another lock",
    (proof) => {
      proof.files["pnpm-lock.yaml"] = "d".repeat(64);
    },
  ],
  [
    "changed check program",
    (proof) => {
      proof.files["scripts/morrowbyte/check.sh"] = "d".repeat(64);
    },
  ],
  [
    "changed helper",
    (proof) => {
      proof.files["scripts/morrowbyte/source-proof.cjs"] = "d".repeat(64);
    },
  ],
  [
    "changed selector",
    (proof) => {
      proof.files["scripts/morrowbyte/test.sh"] = "d".repeat(64);
    },
  ],
  [
    "narrow integration profile",
    (proof) => {
      proof.profile = "check:integration --exact-base";
    },
  ],
  [
    "partial proof",
    (proof) => {
      proof.complete = false;
    },
  ],
  [
    "running proof",
    (proof) => {
      proof.status = "running";
    },
  ],
  [
    "failed proof",
    (proof) => {
      proof.status = "failure";
    },
  ],
  [
    "cancelled proof",
    (proof) => {
      proof.status = "cancelled";
    },
  ],
  [
    "missing group",
    (proof) => {
      proof.groups.pop();
    },
  ],
  [
    "failed group",
    (proof) => {
      proof.groups[0].status = "failure";
    },
  ],
  [
    "skipped group",
    (proof) => {
      proof.groups[0].status = "skipped";
    },
  ],
  [
    "wrong platform",
    (proof) => {
      proof.environment.platform = "win32";
    },
  ],
  [
    "wrong runner",
    (proof) => {
      proof.environment.runnerLabel = "morrowbyte-boat-dev";
    },
  ],
  [
    "wrong Node",
    (proof) => {
      proof.environment.node = "22.0.0";
    },
  ],
  [
    "wrong Vite+",
    (proof) => {
      proof.environment.vitePlus = "0.0.0";
    },
  ],
  [
    "another attempt",
    (proof) => {
      proof.producer.attempt = 1;
    },
  ],
  [
    "another workflow context",
    (proof) => {
      proof.producer.workflowSha = base;
    },
  ],
];
for (const [name, change] of invalidReceipts)
  test(`rejects ${name}`, () => {
    const proof = receipt();
    change(proof);
    assert.throws(() => validateReceipt(proof, expected(), producerRun()));
  });

test("artifact metadata and terminal job state are authoritative, not a JSON assertion", () => {
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    assert.throws(() =>
      validateProvenance({ ...producerRun(), conclusion }, jobs(), artifact(), source),
    );
    const incomplete = jobs();
    incomplete.jobs[0].conclusion = conclusion;
    assert.throws(() => validateProvenance(producerRun(), incomplete, artifact(), source));
  }
  for (const patch of [
    { path: ".github/workflows/morrowbyte-ci.yml" },
    { event: "push" },
    { head_sha: base },
    { status: "in_progress" },
    { repository: { full_name: "elsewhere/repo" } },
  ])
    assert.throws(() =>
      validateProvenance({ ...producerRun(), ...patch }, jobs(), artifact(), source),
    );
  for (const patch of [
    { workflow_run: undefined },
    { workflow_run: { id: 999, head_sha: source } },
    { workflow_run: { id: 456, head_sha: base } },
    { digest: undefined },
    { expired: true },
    { name: artifactName(source, 1) },
  ])
    assert.throws(() =>
      validateProvenance(producerRun(), jobs(), { ...artifact(), ...patch }, source),
    );
  const wrongRunner = jobs();
  wrongRunner.jobs[0].labels = ["self-hosted", "Linux", "X64"];
  assert.throws(() => validateProvenance(producerRun(), wrongRunner, artifact(), source));
});

function apiFixture(change = () => {}, options = {}) {
  const proof = receipt();
  const producer = producerRun();
  const producerJobs = jobs();
  const meta = artifact();
  change({ proof, producer, producerJobs, meta });
  const archive = execFileSync(
    "python3",
    [
      "-c",
      `
import io, sys, zipfile
output = io.BytesIO()
with zipfile.ZipFile(output, 'w') as archive:
    archive.writestr('source-proof.json', sys.stdin.buffer.read())
sys.stdout.buffer.write(output.getvalue())
`,
    ],
    { input: JSON.stringify(proof) },
  );
  meta.digest = options.badDigest ? `sha256:${"f".repeat(64)}` : `sha256:${sha256(archive)}`;
  const ci = {
    ...producerRun(),
    id: 123,
    run_attempt: 1,
    head_branch: "main",
    event: "push",
    path: ".github/workflows/morrowbyte-ci.yml",
    html_url: "https://github.com/morrowbyte/t3code/actions/runs/123",
  };
  const dispatches = [],
    markers = [];
  let main = source;
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async ({ run_id }) => ({ data: run_id === 123 ? ci : producer }),
        listJobsForWorkflowRunAttempt: async ({ run_id }) => ({
          data:
            run_id === 123
              ? {
                  total_count: 1,
                  jobs: [{ name: "check", status: "completed", conclusion: "success" }],
                }
              : producerJobs,
        }),
        listWorkflowRuns: async ({ workflow_id }) => ({
          data:
            workflow_id === "morrowbyte-release.yml"
              ? {
                  total_count: dispatches.length,
                  workflow_runs: dispatches.map(() => ({
                    id: 999,
                    head_sha: source,
                    head_branch: "main",
                    event: "workflow_dispatch",
                    path: ".github/workflows/morrowbyte-release.yml",
                    html_url: "https://github.com/morrowbyte/t3code/actions/runs/999",
                  })),
                }
              : {
                  total_count: options.missing ? 0 : 1,
                  workflow_runs: options.missing ? [] : [producer],
                },
        }),
        listWorkflowRunArtifacts: async () => ({ data: { total_count: 1, artifacts: [meta] } }),
        downloadArtifact: async () => {
          if (options.mainAdvanced) main = base;
          return { data: archive };
        },
        createWorkflowDispatch: async (input) => {
          dispatches.push(input);
          if (options.uncertainAcknowledgement) throw Error("response lost");
        },
      },
      repos: {
        getCommit: async () => ({ data: { sha: source, parents: [{ sha: base }] } }),
        getContent: async ({ path }) => ({
          data: {
            type: "file",
            encoding: "base64",
            content: bytes(path).toString("base64"),
            size: bytes(path).length,
          },
        }),
        listCommitStatusesForRef: async () => ({
          data: options.existingIntent
            ? [{ context: "morrowbyte/nightly-dispatch", state: "pending" }]
            : markers,
        }),
        createCommitStatus: async (input) => {
          markers.push(input);
        },
        listReleases: async () => [],
      },
      git: { getRef: async () => ({ data: { object: { sha: main } } }) },
    },
    paginate: async () => [],
  };
  return {
    dispatches,
    markers,
    artifactDigest: meta.digest,
    verify: (options) =>
      verifySourceProof({ github, repo, source, runId: "456", expected: expected(), ...options }),
    run: () =>
      nightlyAfterCI({
        github,
        context: { repo, payload: { workflow_run: ci } },
        core: { info() {}, setOutput() {} },
      }),
  };
}

test("only API-backed exact full evidence reaches dispatch, carrying immutable artifact identity", async () => {
  const fixture = apiFixture();
  await fixture.run();
  assert.equal(fixture.dispatches.length, 1);
  assert.equal(fixture.dispatches[0].inputs.source_sha, source);
  assert.equal(fixture.dispatches[0].inputs.source_proof_run_id, "456");
  assert.equal(fixture.dispatches[0].inputs.source_proof_artifact_id, "789");
  assert.match(fixture.dispatches[0].inputs.source_proof_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    fixture.markers.map((marker) => marker.state),
    ["pending", "success"],
  );
});

test("every invalid or partial JSON proof fails before durable intent and dispatch", async () => {
  for (const [name, change] of invalidReceipts) {
    const fixture = apiFixture(({ proof }) => change(proof));
    await assert.rejects(fixture.run(), undefined, name);
    assert.equal(fixture.dispatches.length, 0, name);
    assert.equal(fixture.markers.length, 0, name);
  }
});

test("missing, failed, aborted, foreign or unprovenanced runs cannot authorize dispatch", async () => {
  const invalid = [
    [() => {}, { missing: true }],
    [
      ({ producer }) => {
        producer.conclusion = "failure";
      },
    ],
    [
      ({ producer }) => {
        producer.conclusion = "cancelled";
      },
    ],
    [
      ({ producer }) => {
        producer.status = "in_progress";
      },
    ],
    [
      ({ producer }) => {
        producer.path = ".github/workflows/morrowbyte-ci.yml";
      },
    ],
    [
      ({ meta }) => {
        delete meta.workflow_run;
      },
    ],
    [
      ({ producerJobs }) => {
        producerJobs.jobs[0].conclusion = "skipped";
      },
    ],
    [() => {}, { badDigest: true }],
  ];
  for (const [change, options] of invalid) {
    const fixture = apiFixture(change, options);
    await assert.rejects(fixture.run());
    assert.equal(fixture.dispatches.length, 0);
    assert.equal(fixture.markers.length, 0);
  }
});

test("main advancing while proof is read still prevents dispatch", async () => {
  const fixture = apiFixture(undefined, { mainAdvanced: true });
  await fixture.run();
  assert.equal(fixture.dispatches.length, 0);
  assert.equal(fixture.markers.length, 0);
});

test("an existing uncertain intent remains a stop even with available source evidence", async () => {
  const fixture = apiFixture(undefined, { existingIntent: true });
  await assert.rejects(fixture.run(), /existing-intent-without-reconciled-run/);
  assert.equal(fixture.dispatches.length, 0);
});

test("lost dispatch acknowledgement reconciles the same run without sending again", async () => {
  const fixture = apiFixture(undefined, { uncertainAcknowledgement: true });
  await fixture.run();
  assert.equal(fixture.dispatches.length, 1);
});

test("release consumption rejects changed artifact identity and revalidates all source fields", async () => {
  const fixture = apiFixture();
  const identity = { artifactId: "789", artifactDigest: fixture.artifactDigest };
  assert.equal((await fixture.verify(identity)).runId, 456);
  await assert.rejects(
    fixture.verify({ ...identity, artifactId: "790" }),
    /changed-since-dispatch/,
  );
  await assert.rejects(
    fixture.verify({ ...identity, artifactDigest: `sha256:${"f".repeat(64)}` }),
    /changed-since-dispatch/,
  );
  for (const [name, change] of invalidReceipts) {
    const invalid = apiFixture(({ proof }) => change(proof));
    await assert.rejects(
      invalid.verify({ artifactId: "789", artifactDigest: invalid.artifactDigest }),
      undefined,
      name,
    );
  }
});

"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateTrigger, decideDispatch } = require("./nightly-after-ci.cjs");
const source = "a".repeat(40),
  other = "b".repeat(40);
const run = {
  id: 123,
  repository: { full_name: "morrowbyte/t3code" },
  head_repository: { full_name: "morrowbyte/t3code" },
  event: "push",
  head_branch: "main",
  path: ".github/workflows/morrowbyte-ci.yml",
  status: "completed",
  conclusion: "success",
  head_sha: source,
};
const state = () => ({ source, main: source, statuses: [], runs: [], runCount: 0, releases: [] });
test("only successful normal main-push CI qualifies", () => {
  assert.equal(validateTrigger(run, "morrowbyte/t3code"), source);
  const { repository: omitted, ...webhookRun } = run;
  assert.equal(validateTrigger(webhookRun, "morrowbyte/t3code"), source);
  for (const delta of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { head_branch: "morrowbyte/check" },
    { conclusion: "failure" },
    { repository: { full_name: "foreign/repo" } },
  ])
    assert.throws(() => validateTrigger({ ...run, ...delta }, "morrowbyte/t3code"));
});
test("one eligible source without intent requests dispatch", () =>
  assert.equal(decideDispatch(state()).action, "dispatch"));
test("main advancing does not release unpinned source", () =>
  assert.equal(decideDispatch({ ...state(), main: other }).action, "skip"));
test("persisted intent without visible run fails closed for every marker state", () => {
  for (const markerState of ["pending", "success", "error", "failure"])
    assert.equal(
      decideDispatch({
        ...state(),
        statuses: [{ context: "morrowbyte/nightly-dispatch", state: markerState }],
      }).action,
      "stop",
    );
});
test("existing exact run is reconciled, never dispatched again", () => {
  const release = {
    id: 456,
    head_sha: source,
    path: ".github/workflows/morrowbyte-release.yml",
    event: "workflow_dispatch",
    head_branch: "main",
  };
  assert.equal(decideDispatch({ ...state(), runs: [release], runCount: 1 }).action, "reconcile");
  assert.throws(() =>
    decideDispatch({ ...state(), runs: [release, { ...release, id: 457 }], runCount: 2 }),
  );
  const published = {
    id: 789,
    target_commitish: source,
    draft: false,
    published_at: "2026-10-16T18:00:00Z",
  };
  assert.equal(
    decideDispatch({ ...state(), releases: [published] }).reason,
    "source-already-published",
  );
  assert.equal(
    decideDispatch({ ...state(), releases: [{ ...published, target_commitish: other }] }).action,
    "dispatch",
  );
  assert.equal(
    decideDispatch({ ...state(), releases: [{ ...published, draft: true }] }).action,
    "dispatch",
  );
});
test("truncated observations cannot clear intent or invent a unique run", () => {
  assert.throws(() =>
    decideDispatch({ ...state(), statuses: Array(100).fill({ context: "unrelated" }) }),
  );
  assert.throws(() => decideDispatch({ ...state(), runCount: 1 }));
  assert.throws(() => decideDispatch({ ...state(), releases: undefined }));
});

const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");
const { parse } = createRequire(resolve(__dirname, "../../packages/shared/package.json"))("yaml");
const releaseWorkflow = parse(
  readFileSync(resolve(__dirname, "../../.github/workflows/morrowbyte-release.yml"), "utf8"),
);
const expression = (value, inputs, needs, cancelled = false) =>
  Function(
    "inputs",
    "needs",
    "cancelled",
    `return (${value
      .trim()
      .replace(/^\$\{\{/, "")
      .replace(/\}\}$/, "")})`,
  )(inputs, needs, () => cancelled);
const platformInputs = (desktop_only = false) => ({
  desktop_only,
  windows_only: false,
  android_only: false,
  publish: true,
  recover_desktop_run_id: "",
  recover_windows_run_id: "",
  android_source_sha: "",
});
const desktopJobs = ["preflight", "build_bundle", "build_linux", "build_nixos", "build_windows"];
const releaseNeeds = (android) =>
  Object.fromEntries([
    ...desktopJobs.map((name) => [name, { result: "success" }]),
    ["build_android_apk", { result: android }],
  ]);
test("desktop-only release skips Android while the default still requires it", () => {
  assert.equal(releaseWorkflow.on.workflow_dispatch.inputs.desktop_only.default, false);
  assert.equal(
    expression(releaseWorkflow.jobs.build_android_apk.if, platformInputs(true), {}),
    false,
  );
  assert.equal(
    expression(releaseWorkflow.jobs.build_android_apk.if, platformInputs(false), {}),
    true,
  );
  const gate = releaseWorkflow.jobs.publish.if;
  assert.equal(expression(gate, platformInputs(true), releaseNeeds("skipped")), true);
  assert.equal(expression(gate, platformInputs(false), releaseNeeds("skipped")), false);
  assert.equal(expression(gate, platformInputs(false), releaseNeeds("success")), true);
  assert.equal(expression(gate, platformInputs(true), releaseNeeds("success")), false);
});
test("every desktop package and cancellation gate remains required in either mode", () => {
  const gate = releaseWorkflow.jobs.publish.if;
  for (const desktopOnly of [false, true]) {
    const inputs = platformInputs(desktopOnly),
      needs = releaseNeeds(desktopOnly ? "skipped" : "success");
    for (const job of desktopJobs)
      assert.equal(expression(gate, inputs, { ...needs, [job]: { result: "failure" } }), false);
    assert.equal(expression(gate, { ...inputs, publish: false }, needs), false);
    assert.equal(expression(gate, inputs, needs, true), false);
  }
  const recoveryNeeds = Object.fromEntries([
    ...desktopJobs.map((name) => [name, { result: name === "preflight" ? "success" : "skipped" }]),
    ["build_android_apk", { result: "success" }],
  ]);
  assert.equal(
    expression(gate, { ...platformInputs(), recover_desktop_run_id: "39093205395" }, recoveryNeeds),
    true,
  );
});
test("desktop-only cannot enter Android recovery or publish mobile assets", () => {
  const steps = releaseWorkflow.jobs.preflight.steps;
  const validation = steps.find((step) => step.name === "Validate platform selection");
  const run = (desktop, recovery, windows = "", android = "", androidOnly = false) =>
    spawnSync("bash", ["-c", validation.run], {
      env: {
        ...process.env,
        DESKTOP_ONLY: String(desktop),
        ANDROID_ONLY: String(androidOnly),
        RECOVERY_RUN_ID: recovery,
        WINDOWS_RECOVERY_RUN_ID: windows,
        ANDROID_SOURCE_SHA: android,
      },
    }).status;
  assert.equal(run(true, ""), 0);
  assert.equal(run(false, "39093205395"), 0);
  assert.notEqual(run(true, "39093205395"), 0);
  assert.equal(run(false, "", "39182028263"), 0);
  assert.notEqual(run(true, "", "39182028263"), 0);
  assert.notEqual(run(false, "39093205395", "39182028263"), 0);
  assert.notEqual(run(false, "", "39182028263", source), 0);
  assert.equal(run(false, "", "", "", true), 0);
  assert.notEqual(run(true, "", "", "", true), 0);
  assert.notEqual(run(false, "39093205395", "", "", true), 0);
  assert.notEqual(run(false, "", "39182028263", "", true), 0);
  assert.notEqual(run(false, "", "", source, true), 0);
  const publishSteps = releaseWorkflow.jobs.publish.steps;
  const androidProof = publishSteps.find(
    (step) => step.name === "Verify Android bytes from this build before publication",
  );
  assert.equal(expression(androidProof.if, platformInputs(true), {}), false);
  const payload = publishSteps.find((step) => step.name === "Verify isolated release payload");
  assert.match(payload.run, /DESKTOP_ONLY/);
  assert.match(payload.run, /\*\.apk/);
  assert.equal(
    Object.keys(releaseWorkflow.jobs).some((name) => /mac/i.test(name)),
    false,
  );
});
test("Android artifacts retain normal source checks without requiring main publication CI", () => {
  const steps = releaseWorkflow.jobs.preflight.steps;
  const inputs = { ...platformInputs(), android_only: true, publish: false };
  assert.equal(expression(steps.find((step) => step.id === "android_ci").if, inputs, {}), false);
  for (const name of [
    "Prepare pinned Electron runtime before desktop imports",
    "Install pinned Chromium for focused renderer gates",
    "Check source before release",
    "Verify reviewed Observatory preflight route",
  ])
    assert.equal(expression(steps.find((step) => step.name === name).if, inputs, {}), true, name);
  const publishing = { ...inputs, publish: true };
  assert.equal(expression(steps.find((step) => step.id === "android_ci").if, publishing, {}), true);
  assert.equal(
    expression(
      steps.find((step) => step.name === "Check source before release").if,
      publishing,
      {},
    ),
    false,
  );
});
test("Android-only publication never schedules desktop packages", () => {
  const inputs = { ...platformInputs(), android_only: true };
  const needs = releaseNeeds("success");
  for (const name of ["build_bundle", "build_linux", "build_nixos", "build_windows", "publish"])
    assert.equal(expression(releaseWorkflow.jobs[name].if, inputs, needs), false, name);
  assert.equal(expression(releaseWorkflow.jobs.build_android_apk.if, inputs, needs), true);
  assert.equal(expression(releaseWorkflow.jobs.publish_android.if, inputs, needs), true);
  assert.equal(
    expression(releaseWorkflow.jobs.publish_android.if, { ...inputs, publish: false }, needs),
    false,
  );
});
test("pinned Windows recovery reuses successful platforms but still requires Windows and original preflight", () => {
  const inputs = { ...platformInputs(), recover_windows_run_id: "39182028263" };
  const needs = Object.fromEntries([
    ...desktopJobs.map((name) => [
      name,
      { result: ["preflight", "build_windows"].includes(name) ? "success" : "skipped" },
    ]),
    ["build_android_apk", { result: "skipped" }],
  ]);
  for (const name of ["build_bundle", "build_linux", "build_nixos", "build_android_apk"])
    assert.equal(expression(releaseWorkflow.jobs[name].if, inputs, needs), false);
  assert.equal(expression(releaseWorkflow.jobs.build_windows.if, inputs, needs), true);
  assert.equal(expression(releaseWorkflow.jobs.publish.if, inputs, needs), true);
  for (const name of ["preflight", "build_windows"])
    assert.equal(
      expression(releaseWorkflow.jobs.publish.if, inputs, {
        ...needs,
        [name]: { result: "failure" },
      }),
      false,
    );
  assert.equal(expression(releaseWorkflow.jobs.publish.if, inputs, needs, true), false);
  assert.equal(
    expression(
      releaseWorkflow.jobs.publish.if,
      { ...inputs, recover_windows_run_id: "other" },
      needs,
    ),
    false,
  );
  assert.equal(
    expression(releaseWorkflow.jobs.publish.if, { ...inputs, publish: false }, needs),
    false,
  );
});

const windowsOnly = require("./windows-only-release.cjs");
test("Windows-only builds no other platform and requires every Windows dependency", () => {
  const inputs = { ...platformInputs(), windows_only: true };
  const needs = Object.fromEntries([
    ...desktopJobs.map((name) => [
      name,
      {
        result: ["preflight", "build_bundle", "build_windows"].includes(name)
          ? "success"
          : "skipped",
      },
    ]),
    ["build_android_apk", { result: "skipped" }],
  ]);
  assert.equal(expression(releaseWorkflow.jobs.build_windows.if, inputs, needs), true);
  for (const name of [
    "build_linux",
    "build_nixos",
    "build_android_apk",
    "publish",
    "publish_android",
  ])
    assert.equal(expression(releaseWorkflow.jobs[name].if, inputs, needs), false, name);
  assert.equal(expression(releaseWorkflow.jobs.publish_windows.if, inputs, needs), true);
  for (const name of ["preflight", "build_bundle", "build_windows"])
    assert.equal(
      expression(releaseWorkflow.jobs.publish_windows.if, inputs, {
        ...needs,
        [name]: { result: "failure" },
      }),
      false,
    );
  for (const name of ["build_linux", "build_nixos", "build_android_apk"])
    assert.equal(
      expression(releaseWorkflow.jobs.publish_windows.if, inputs, {
        ...needs,
        [name]: { result: "success" },
      }),
      false,
    );
  assert.equal(expression(releaseWorkflow.jobs.publish_windows.if, inputs, needs, true), false);
  const script = releaseWorkflow.jobs.preflight.steps.find(
    (step) => step.name === "Validate platform selection",
  ).run;
  const run = (patch = {}) =>
    spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        WINDOWS_ONLY: "true",
        DESKTOP_ONLY: "false",
        ANDROID_ONLY: "false",
        RECOVERY_RUN_ID: "",
        WINDOWS_RECOVERY_RUN_ID: "",
        ANDROID_SOURCE_SHA: "",
        ...patch,
      },
    }).status;
  assert.equal(run(), 0);
  for (const patch of [
    { DESKTOP_ONLY: "true" },
    { ANDROID_ONLY: "true" },
    { RECOVERY_RUN_ID: "39093205395" },
    { WINDOWS_RECOVERY_RUN_ID: "39182028263" },
    { ANDROID_SOURCE_SHA: source },
  ])
    assert.notEqual(run(patch), 0);
});
test("published WSL runtime reuse rejects backend and dependency changes", () => {
  windowsOnly.assertRuntimeSourceUnchanged([
    "apps/desktop/src/wsl/DesktopWslEnvironment.ts",
    ".github/workflows/morrowbyte-release.yml",
  ]);
  for (const path of [
    "apps/server/src/bin.ts",
    "packages/contracts/src/server.ts",
    "pnpm-lock.yaml",
    "package.json",
    "apps/server/scripts/cli.ts",
  ])
    assert.throws(() => windowsOnly.assertRuntimeSourceUnchanged([path]));
});
test("Windows checkout retains the pinned runtime ancestor for the source comparison", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "t3-windows-history-"));
  const origin = path.join(root, "origin");
  const checkout = path.join(root, "checkout");
  const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8" });
  const checked = (cwd, args) => {
    const result = git(cwd, args);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(origin);
    checked(origin, ["init", "--initial-branch=main"]);
    const commit = (message) =>
      checked(origin, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        message,
      ]);
    commit("Published runtime source");
    const runtimeSource = checked(origin, ["rev-parse", "HEAD"]);
    commit("Desktop-only source change");
    const step = releaseWorkflow.jobs.build_windows.steps.find((entry) =>
      entry.uses?.startsWith("actions/checkout@"),
    );
    const depth = Number(step.with["fetch-depth"]);
    assert(Number.isInteger(depth) && depth >= 0);
    checked(root, [
      "clone",
      "--no-tags",
      ...(depth === 0 ? [] : ["--depth", String(depth)]),
      require("node:url").pathToFileURL(origin).href,
      checkout,
    ]);
    const comparison = git(checkout, ["merge-base", "--is-ancestor", runtimeSource, "HEAD"]);
    assert.equal(comparison.status, 0, comparison.stderr);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Windows-only feed keeps the published Linux version and original bytes reachable", () => {
  const original = Buffer.from(
    "version: 0.1.2-nightly.20261020.61\nfiles:\n  - url: T3-Code-0.1.2-nightly.20261020.61-x86_64.AppImage\n    sha512: e2ZXNaeB8j3TiIaDmbLReMvxtoQ98FGMjZLGRx2WuyHxfnktGEkOdVxIqEbj1oq6zMZWMhBZSIBF9DUJ+XA+QQ==\n    size: 165406392\n    blockMapSize: 175292\npath: T3-Code-0.1.2-nightly.20261020.61-x86_64.AppImage\nsha512: e2ZXNaeB8j3TiIaDmbLReMvxtoQ98FGMjZLGRx2WuyHxfnktGEkOdVxIqEbj1oq6zMZWMhBZSIBF9DUJ+XA+QQ==\nreleaseDate: '2026-10-20T06:09:34.482Z'\n",
  );
  const feed = createRequire(resolve(__dirname, "../../packages/shared/package.json"))(
    "yaml",
  ).parse(windowsOnly.preserveLinuxFeed(original));
  assert.equal(feed.version, "0.1.2-nightly.20261020.61");
  assert.equal(
    feed.files[0].url,
    "https://github.com/morrowbyte/t3code/releases/download/v0.1.2-nightly.20261020.61/T3-Code-0.1.2-nightly.20261020.61-x86_64.AppImage",
  );
  assert.equal(feed.path, feed.files[0].url);
  assert.equal(
    feed.files[0].sha512,
    createRequire(resolve(__dirname, "../../packages/shared/package.json"))("yaml").parse(
      original.toString(),
    ).files[0].sha512,
  );
  assert.throws(() =>
    windowsOnly.preserveLinuxFeed(
      Buffer.from(original.toString().replace("165406392", "165406393")),
    ),
  );
  assert.equal(
    "Morrowbyte Windows Nightly 0.1.2-nightly.20261020.62".startsWith("Morrowbyte Nightly"),
    false,
  );
});

test("Windows-only publication assembles the actual producer artifacts before validation", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "t3-windows-payload-"));
  const version = "0.1.2-nightly.20261020.62";
  try {
    const producers = new Map();
    const assets = path.join(root, "release-assets");
    fs.mkdirSync(assets);
    fs.writeFileSync(path.join(assets, "WINDOWS-ONLY.json"), "{}\n");
    fs.writeFileSync(
      path.join(assets, "nightly-linux.yml"),
      "version: 0.1.2-nightly.20261020.61\nfiles:\n  - url: https://github.com/morrowbyte/t3code/releases/download/v0.1.2-nightly.20261020.61/retained.AppImage\n",
    );
    const payloads = {
      "release-windows": {
        [`T3-Code-${version}-x64.exe`]: "installer-fixture",
        [`T3-Code-${version}-x64.exe.blockmap`]: "blockmap-fixture",
        "nightly.yml": `version: ${version}\n`,
      },
      "release-cli": { [`t3-${version}-win32-x64.zip`]: "cli-archive-fixture" },
    };
    for (const step of releaseWorkflow.jobs.build_windows.steps) {
      if (!step.uses?.startsWith("actions/upload-artifact@")) continue;
      const directory = step.with.path.replace(/\/\*$/, "");
      if (!(directory in payloads)) continue;
      const producer = path.join(root, "producer", directory);
      fs.mkdirSync(producer, { recursive: true });
      for (const [name, bytes] of Object.entries(payloads[directory]))
        fs.writeFileSync(path.join(producer, name), bytes);
      producers.set(step.with.name, producer);
    }
    for (const step of releaseWorkflow.jobs.publish_windows.steps) {
      if (!step.uses?.startsWith("actions/download-artifact@")) continue;
      const producer = producers.get(step.with.name);
      assert(producer, `No Windows producer for ${step.with.name}`);
      const destination = path.join(root, step.with.path);
      fs.mkdirSync(destination, { recursive: true });
      for (const name of fs.readdirSync(producer))
        fs.copyFileSync(path.join(producer, name), path.join(destination, name));
    }
    assert(windowsOnly.validatePayload(assets, version).includes(`t3-${version}-win32-x64.zip`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

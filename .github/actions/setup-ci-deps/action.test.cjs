const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { createRequire } = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const yaml = createRequire(path.resolve(__dirname, "../../../packages/shared/package.json"))(
  "yaml",
);
const action = yaml.parse(fs.readFileSync(path.join(__dirname, "action.yml"), "utf8"));
const resolve = action.runs.steps.find((step) => step.id === "toolchain");

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "setup-ci-deps-"));
  try {
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), 'lockfileVersion: "9.0"\n');
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "catalog:\n  vite-plus: 1.4.0\n");
    fs.writeFileSync(path.join(root, "package.json"), '{"packageManager":"pnpm@12.14.0"}\n');
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(root, install, args = "") {
  const output = path.join(root, "outputs");
  fs.writeFileSync(output, "");
  const result = spawnSync("bash", ["-c", resolve.run], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: root,
      INSTALL: install,
      INSTALL_ARGS: args,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return Object.fromEntries(
    fs
      .readFileSync(output, "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const split = line.indexOf("=");
        return [line.slice(0, split), line.slice(split + 1)];
      }),
  );
}

test("cache identity distinguishes filtered closures, lockfiles and pinned toolchains", () =>
  fixture((root) => {
    const digest = (args) => {
      const outputs = run(root, "true", args);
      assert.equal(outputs.version, "1.4.0");
      const contents = fs.readFileSync(outputs["cache-key"]);
      assert.equal(yaml.parse(contents.toString()).lockfileVersion, "9.0");
      return createHash("sha256").update(contents).digest("hex");
    };
    const full = digest("--frozen-lockfile");
    assert.equal(digest("--frozen-lockfile"), full);
    assert.notEqual(digest("--frozen-lockfile --filter=t3..."), full);
    fs.appendFileSync(path.join(root, "pnpm-lock.yaml"), "settings: {}\n");
    const lockChanged = digest("--frozen-lockfile");
    assert.notEqual(lockChanged, full);
    fs.writeFileSync(path.join(root, "package.json"), '{"packageManager":"pnpm@12.15.0"}\n');
    assert.notEqual(digest("--frozen-lockfile"), lockChanged);
  }));

test("toolchain-only setup has no store identity and only the permitted pinned action", () =>
  fixture((root) => {
    assert.deepEqual(run(root, "false"), { version: "1.4.0" });
    assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
    const external = action.runs.steps.filter((step) => step.uses);
    assert.equal(external.length, 1);
    assert.equal(
      external[0].uses,
      "voidzero-dev/setup-vp@250f29ce396baf5e8f24498e17c0dfdebabc26eb",
    );
    assert.equal(external[0].with["run-install"], false);
    assert.equal(external[0].with.cache, "${{ inputs.install == 'true' }}");
  }));

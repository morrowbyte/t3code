// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Focused filesystem transport tests.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { publishEditorFileChanges, firstChangedLine } from "./EditorFollow.ts";
const base = await fs.mkdtemp(
  path.join((await import("node:os")).tmpdir(), "t3-editor-follow-test-"),
);
async function fixture() {
  const root = await fs.mkdtemp(path.join(base, "case-"));
  const project = path.join(root, "project"),
    queue = path.join(root, "queue");
  await fs.mkdir(project);
  await fs.mkdir(queue);
  await fs.writeFile(path.join(project, "a.tsx"), "first");
  await fs.writeFile(path.join(project, "b.sql"), "second");
  await fs.writeFile(
    path.join(queue, "connection.json"),
    JSON.stringify({
      version: 1,
      project,
      sessionId: "owned-session",
      ready: true,
      expiresUnixMs: Date.now() + 6000,
    }),
  );
  return {
    root,
    project,
    queue,
    input: {
      queueDirectory: queue,
      selectedThreadId: "owned-thread",
      threadId: "owned-thread",
      workspaceRoot: project,
      itemId: "owned-item",
      changes: [
        { path: "a.tsx", diff: "@@ -1,2 +8,3 @@" },
        { path: "b.sql", diff: "@@ -1,1 +5,1 @@" },
      ],
    },
  };
}
test("all changed files are session-bound, line-addressed and published once", async () => {
  const f = await fixture();
  assert.deepEqual(await publishEditorFileChanges(f.input), { queued: 2, skipped: 0 });
  const names = (await fs.readdir(f.queue)).filter((n) => n.endsWith(".request.json"));
  const original = await Promise.all(names.map((n) => fs.readFile(path.join(f.queue, n), "utf8")));
  const rows = original.map(JSON.parse);
  assert.deepEqual(
    rows.map((r) => r.line).sort((a, b) => a - b),
    [5, 8],
  );
  assert(
    rows.every((r) => r.op === "follow" && r.sessionId === "owned-session" && !("content" in r)),
  );
  assert.deepEqual(await publishEditorFileChanges(f.input), { queued: 0, skipped: 2 });
  assert.deepEqual(
    await Promise.all(names.map((n) => fs.readFile(path.join(f.queue, n), "utf8"))),
    original,
  );
});
test("another thread never probes the configured queue", async () => {
  assert.deepEqual(
    await publishEditorFileChanges({
      queueDirectory: "nonexistent",
      selectedThreadId: "one",
      threadId: "two",
      workspaceRoot: "nonexistent",
      itemId: "one",
      changes: [{ path: "x.js", diff: "" }],
    }),
    { queued: 0, skipped: 1 },
  );
});
test("expired and inactive editor bindings are refused", async () => {
  const f = await fixture();
  await fs.writeFile(
    path.join(f.queue, "connection.json"),
    JSON.stringify({
      version: 1,
      project: f.project,
      sessionId: "stale",
      ready: true,
      expiresUnixMs: Date.now() - 1,
    }),
  );
  await assert.rejects(publishEditorFileChanges(f.input), /No current editor connection/);
  assert.equal((await fs.readdir(f.queue)).filter((n) => n.endsWith(".request.json")).length, 0);
});
test("a different project cannot redirect editor follow", async () => {
  const f = await fixture();
  const other = path.join(f.root, "other");
  await fs.mkdir(other);
  await assert.rejects(publishEditorFileChanges({ ...f.input, workspaceRoot: other }), /outside/);
});
test("deleted, private and escaping paths produce no requests", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.project, ".private.ts"), "synthetic-private");
  await fs.writeFile(path.join(f.root, "outside.ts"), "outside");
  assert.deepEqual(
    await publishEditorFileChanges({
      ...f.input,
      changes: [
        { path: "missing.ts", diff: "" },
        { path: ".private.ts", diff: "" },
        { path: "../outside.ts", diff: "" },
      ],
    }),
    { queued: 0, skipped: 3 },
  );
});

test("diff context resolves the changed source line, not the hunk beginning", () => {
  assert.equal(firstChangedLine("@@ -2 +9 @@ return x + 100\n-old\n+new"), 9);
  assert.equal(
    firstChangedLine(
      "@@ -1,5 +1,5 @@" +
        String.fromCharCode(10) +
        " first" +
        String.fromCharCode(10) +
        " second" +
        String.fromCharCode(10) +
        "-old" +
        String.fromCharCode(10) +
        "+new",
    ),
    3,
  );
  assert.equal(firstChangedLine("@@ -0,0 +1,2 @@" + String.fromCharCode(10) + "+new"), 1);
  assert.equal(firstChangedLine(""), 1);
});

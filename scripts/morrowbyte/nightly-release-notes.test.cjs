"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { previousTag, renderNotes } = require("./nightly-release-notes.cjs");

test("selects the latest published older nightly on the source history", () => {
  const release = (tagName, isDraft = false) => ({ tagName, isDraft, publishedAt: "2026-11-09" });
  const releases = [
    release("v0.1.8-nightly.20261109.109"),
    release("v0.1.8-nightly.20261108.108"),
    release("v0.1.8-nightly.20261107.107", true),
    release("v0.1.8"),
    release("v0.1.9-nightly.20261110.110"),
  ];
  assert.equal(
    previousTag(
      releases,
      "v0.1.9-nightly.20261111.111",
      (tag) => tag.endsWith("109") || tag.endsWith("108"),
    ),
    "v0.1.8-nightly.20261109.109",
  );
  assert.equal(
    previousTag(releases, "v0.1.9-nightly.20261111.111", (tag) => tag.endsWith("108")),
    "v0.1.8-nightly.20261108.108",
  );
  assert.equal(
    previousTag(releases, "v0.1.9-nightly.20261111.111", () => false),
    undefined,
  );
});

test("shows features and fixes while omitting test and release maintenance", () => {
  const notes = renderNotes(
    [
      "test(web): check layout",
      "fix(release): qualify source",
      "fix(desktop): match Windows client bounds",
      "feat(files): open documents in default apps",
      "fix(desktop): match Windows client bounds",
    ],
    "old",
    "new",
    "morrowbyte/t3code",
  );
  assert.match(notes, /- match Windows client bounds/);
  assert.match(notes, /- open documents in default apps/);
  assert.doesNotMatch(notes, /check layout|qualify source|fix\(desktop\)/);
  assert.equal(notes.match(/match Windows/g).length, 1);
  assert.match(notes, /compare\/old\.\.\.new/);
  assert.match(
    renderNotes(["test: check"], "old", "new", "morrowbyte/t3code"),
    /No user-facing changes/,
  );
});

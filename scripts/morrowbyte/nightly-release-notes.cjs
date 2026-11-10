"use strict";

const { execFileSync } = require("node:child_process");

function version(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)-nightly\.(\d{8})\.(\d+)$/.exec(tag);
  return match ? match.slice(1).map(Number) : null;
}

function compare(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function previousTag(releases, currentTag, isAncestor) {
  const current = version(currentTag);
  if (!current) throw new Error(`Invalid nightly tag: ${currentTag}`);
  const candidates = releases
    .filter((release) => !release.isDraft && release.publishedAt && version(release.tagName))
    .filter((release) => compare(version(release.tagName), current) < 0)
    .sort((a, b) => compare(version(b.tagName), version(a.tagName)));
  return candidates.find((release) => isAncestor(release.tagName))?.tagName;
}

function renderNotes(subjects, previous, current, repository) {
  const items = subjects.flatMap((subject) => {
    const match = /^(feat|fix|perf)(?:\(([^)]+)\))?!?:\s+(.+)$/.exec(subject);
    if (!match || /^(release|ci|build|deps|test|tests)$/i.test(match[2] || "")) return [];
    return [match[3].trim()];
  });
  const unique = [...new Set(items)];
  const entries = unique.length ? unique.map((item) => `- ${item}`).join("\n") : "No user-facing changes were identified for this release.";
  return `## What's changed\n\n${entries}\n\nFull Changelog: https://github.com/${repository}/compare/${previous}...${current}\n`;
}

function generateNotes(current, source, repository) {
  if (!current || !source || !repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Expected tag, source and repository");
  const releases = JSON.parse(execFileSync("gh", ["release", "list", "--repo", repository, "--limit", "1000", "--json", "tagName,isDraft,publishedAt"], { encoding: "utf8" }));
  const previous = previousTag(releases, current, (tag) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", `refs/tags/${tag}^{commit}`, source], { stdio: "ignore" });
      return true;
    } catch { return false; }
  });
  if (!previous) throw new Error("No previous published nightly on the source history; cannot determine release changes");
  const subjects = execFileSync("git", ["log", "--reverse", "--no-merges", "--format=%s", `refs/tags/${previous}..${source}`], { encoding: "utf8" }).split(/\r?\n/);
  return renderNotes(subjects, previous, current, repository);
}

function main() {
  const [current, source, repository, output] = process.argv.slice(2);
  if (!output) throw new Error("Expected output path");
  require("node:fs").writeFileSync(output, generateNotes(current, source, repository));
}

if (require.main === module) main();
module.exports = { generateNotes, previousTag, renderNotes };

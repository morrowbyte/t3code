import { assert, it } from "vite-plus/test";
import { resolveWindowsWslRuntimeVersion } from "./build-desktop-artifact.ts";

it("preserves the desktop version guard unless .61 reuse is explicitly enabled", () => {
  const digest = "a469af45aaf05af7ad1103b327e83a1824984c2ed5a5534d8c2e32a4b5440d6d";
  assert.equal(
    resolveWindowsWslRuntimeVersion("0.1.2-nightly.20261020.62", digest),
    "0.1.2-nightly.20261020.62",
  );
  assert.equal(
    resolveWindowsWslRuntimeVersion("0.1.2-nightly.20261020.62", digest, true),
    "0.1.2-nightly.20261020.61",
  );
});

it("rejects every unpinned archive when .61 reuse is enabled", () => {
  assert.equal(
    resolveWindowsWslRuntimeVersion("0.1.2-nightly.20261020.62", "b".repeat(64), true),
    null,
  );
});

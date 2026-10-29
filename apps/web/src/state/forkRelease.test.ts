import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { forkReleaseAtom } from "./forkRelease";

it("reads the fork feed and never infers migration compatibility from a release version", async () => {
  using fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json([
      { tag_name: "v0.1.5", draft: false },
      { tag_name: "v0.1.2-nightly.20261029.99", draft: true },
      { tag_name: "v0.1.2-nightly.20261029.76", draft: false },
    ]),
  );
  const registry = AtomRegistry.make();
  try {
    const atom = forkReleaseAtom("nightly");
    registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.getOrElse(registry.get(atom), () => null)).toEqual({
        version: "0.1.2-nightly.20261029.76",
        databaseMigration: undefined,
      });
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/morrowbyte/t3code/releases?per_page=100&page=1",
    );
  } finally {
    registry.dispose();
  }
});

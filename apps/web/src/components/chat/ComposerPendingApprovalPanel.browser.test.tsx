import { RuntimeRequestId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(overrides: Partial<PendingApproval>) {
  await act(async () =>
    root.render(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: RuntimeRequestId.make("approval-panel"),
          requestKind: "command",
          createdAt: "2026-10-18T00:00:00.000Z",
          responseCapability: "live",
          detail: "",
          ...overrides,
        }}
        pendingCount={1}
      />,
    ),
  );
}
function showDetails() {
  container.querySelector("summary")!.click();
}

describe("ComposerPendingApprovalPanel", () => {
  it("keeps the complete command readable in provider details", async () => {
    const detail = `bun run release -- ${"x".repeat(500)}\nsecond line`;
    await render({ detail });
    showDetails();
    expect(container.querySelector("pre")?.textContent).toBe(detail);
    expect(container.textContent).not.toContain("Command approval requested");
  });
  it("keeps the approval kind available when the provider sends empty details", async () => {
    await render({ requestKind: "file-read" });
    expect(container.querySelector("section")?.getAttribute("aria-label")).toBe(
      "File read approval",
    );
    expect(container.textContent).toContain("Read files");
    showDetails();
    expect(container.querySelector("pre")?.textContent).toBe("No details supplied");
  });
  it.each(["Safari", "A".repeat(200)])(
    "preserves the full app name %s and approval message",
    async (appName) => {
      const detail = "Allow ChatGPT to access the selected application?";
      await render({ requestKind: "mcp-elicitation", appName, detail });
      expect(container.textContent).toContain(appName);
      showDetails();
      expect(container.querySelector("pre")?.textContent).toBe(detail);
    },
  );
});

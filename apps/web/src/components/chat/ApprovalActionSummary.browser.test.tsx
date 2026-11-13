import { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import type { PendingApproval } from "../../session-logic";
import { ApprovalActionSummary } from "./ApprovalActionSummary";

const approval: PendingApproval = {
  requestId: RuntimeRequestId.make("approval-visual"),
  requestKind: "command",
  createdAt: "2026-10-15T00:00:00.000Z",
  responseCapability: "live",
  detail: "sudo bash -c 'printf 执行\\n'\n" + "# long code\n".repeat(200),
};
function value(host: HTMLElement, label: string) {
  return [...host.querySelectorAll("dt")].find((item) => item.textContent === label)
    ?.nextElementSibling?.textContent;
}

describe("ApprovalActionSummary", () => {
  it("keeps exact long Unicode provider code available without interpreting OS authority", async () => {
    await using screen = await render(
      <ApprovalActionSummary
        approval={approval}
        environmentId={EnvironmentId.make("peer-node")}
        runtimeMode="auto"
      />,
    );
    await screen.getByText("Provider details", { exact: true }).click();
    expect(screen.container.querySelector('[aria-label="Recorded input"]')?.textContent).toBe(
      approval.detail,
    );
    expect(value(screen.container, "OS privilege")).toBe("Not supplied");
    expect(value(screen.container, "Effective provider policy")).toBe("Not supplied");
    expect(value(screen.container, "Configured mode")).toBe("Auto");
    expect(screen.container.textContent).toContain("Execution unconfirmed");
    expect(screen.container.textContent).toContain("Verification unconfirmed");
  });
  it("updates the actual peer target and closes old details when environments switch", async () => {
    await using screen = await render(
      <ApprovalActionSummary
        approval={approval}
        environmentId={EnvironmentId.make("peer-a")}
        environmentLabel="RemoteHost"
      />,
    );
    await screen.getByText("Provider details", { exact: true }).click();
    expect(screen.container.querySelector("details")?.open).toBe(true);
    await screen.rerender(
      <ApprovalActionSummary
        approval={approval}
        environmentId={EnvironmentId.make("peer-b")}
        environmentLabel="NodeX37"
      />,
    );
    expect(value(screen.container, "Destination environment")).toBe("NodeX37");
    expect(value(screen.container, "Environment ID")).toBe("peer-b");
    expect(screen.container.textContent).not.toContain("RemoteHost");
    expect(screen.container.querySelector("details")?.open).toBe(false);
  });
  it("preserves provider-specific scope labels and fallback warnings without inventing a grant", async () => {
    await using screen = await render(
      <ApprovalActionSummary
        approval={{
          ...approval,
          options: [
            {
              decision: "acceptAlways",
              label: "Allow Safari",
              warning: "Provider applies this choice once for this request.",
            },
            { decision: "cancel", label: "Cancel request" },
          ],
        }}
      />,
    );
    expect(screen.container.textContent).toContain("Allow Safari");
    expect(screen.container.textContent).toContain(
      "Provider applies this choice once for this request.",
    );
    expect(screen.container.textContent).not.toContain("Always allow this session");
    expect(value(screen.container, "Structured resource scope")).toBe("Not supplied");
  });
  it("keeps original request details inspectable after provider disconnection", async () => {
    await using screen = await render(
      <ApprovalActionSummary approval={{ ...approval, responseCapability: "not_resumable" }} />,
    );
    await screen.getByText("Provider details", { exact: true }).click();
    expect(screen.container.textContent).toContain("Provider disconnected");
    expect(screen.container.querySelector('[aria-label="Recorded input"]')?.textContent).toBe(
      approval.detail,
    );
  });
  it("does not create a confirmation for full-access mode without an actual approval", async () => {
    await using screen = await render(
      <ApprovalActionSummary approval={null} runtimeMode="full-access" />,
    );
    expect(screen.container.textContent).toBe("");
    expect(screen.container.querySelector("button")).toBeNull();
  });
});

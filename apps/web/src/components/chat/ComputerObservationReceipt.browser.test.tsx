import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const harness = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../state/queries", () => ({ useTurnItemDetail: harness.query }));
import { ComputerObservationReceipt } from "./ComputerObservationReceipt";

const environmentId = EnvironmentId.make("native-test");
const item = {
  id: TurnItemId.make("native-status"),
  threadId: ThreadId.make("native-thread"),
  runId: RunId.make("native-run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: "never expose this window title",
  startedAt: DateTime.makeUnsafe("2026-11-07T12:00:00Z"),
  completedAt: DateTime.makeUnsafe("2026-11-07T12:00:01Z"),
  updatedAt: DateTime.makeUnsafe("2026-11-07T12:00:01Z"),
  type: "dynamic_tool" as const,
  toolName: "mcp__weasel_desktop__desktop_status",
  input: { secret: "never expose this action payload" },
  outputOmitted: true,
};
const projectedItem: OrchestrationV2ProjectedTurnItem = {
  position: 1,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
};
const output = {
  schema: 1,
  observation_mode: "disabled",
  observation_active: false,
  observation_generation: 1,
};

function panel() {
  return <ComputerObservationReceipt projectedItem={projectedItem} environmentId={environmentId} />;
}

it("keeps a fetched native receipt historical and clears it on detail failure", async () => {
  harness.query.mockReset().mockReturnValue({ data: null, isPending: true, error: null });
  await using screen = await render(panel());
  await expect
    .element(screen.getByText("Bei diesem Aufruf: Keine bestätigte Rückmeldung"))
    .toBeVisible();

  harness.query.mockReturnValue({
    data: { item: { ...item, outputOmitted: false, output } },
    isPending: false,
    error: null,
  });
  await screen.rerender(panel());
  await expect.element(screen.getByText("Bei diesem Aufruf: Blick aus")).toBeVisible();
  expect(screen.container.textContent).not.toContain("never expose");

  harness.query.mockReturnValue({
    data: { item: { ...item, outputOmitted: false, output } },
    isPending: false,
    error: "disconnected",
  });
  await screen.rerender(panel());
  await expect
    .element(screen.getByText("Bei diesem Aufruf: Keine bestätigte Rückmeldung"))
    .toBeVisible();
  expect(screen.container.textContent).not.toContain("Blick aus");
});

it("rejects an old revision and a result belonging to another native call", async () => {
  harness.query.mockReset().mockReturnValue({
    data: {
      item: {
        ...item,
        updatedAt: DateTime.makeUnsafe("2026-11-07T12:00:00Z"),
        outputOmitted: false,
        output,
      },
    },
    isPending: false,
    error: null,
  });
  await using screen = await render(panel());
  await expect
    .element(screen.getByText("Bei diesem Aufruf: Keine bestätigte Rückmeldung"))
    .toBeVisible();
  harness.query.mockReturnValue({
    data: { item: { ...item, id: TurnItemId.make("other-call"), outputOmitted: false, output } },
    isPending: false,
    error: null,
  });
  await screen.rerender(panel());
  await expect
    .element(screen.getByText("Bei diesem Aufruf: Keine bestätigte Rückmeldung"))
    .toBeVisible();
});

import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  ProjectFeatureTiming as TimingSchema,
  type ProjectFeatureTimingHistory,
} from "@t3tools/contracts";
import { projectFeatureTiming } from "@t3tools/shared/featureTiming";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import "../../index.css";

const state = vi.hoisted(() => ({
  read: vi.fn<() => Promise<unknown>>(),
  environment: { connection: { phase: "connected" } },
  connection: {},
  session: {},
}));
vi.mock(import("../../state/projects"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const permission = Atom.make(true);
  return {
    ...(await original()),
    readProjectFeatureTiming: { permissionAtom: () => permission } as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => state.environment) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  usePreparedConnection: (() => state.connection) as never,
  useEnvironmentSessionState: (() => ({ data: state.session })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.read) as never,
}));

import { ProjectFeatureTiming } from "./ProjectFeatureTiming";

const projectId = ProjectId.make("timing-fixture");
const threadId = ThreadId.make("timing-fixture-thread");
const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 10, minute)).toISOString();
const history: ProjectFeatureTimingHistory = {
  projectId,
  asOf: at(30),
  coverage: "complete",
  records: [
    {
      sequence: 1,
      at: at(0),
      fact: {
        type: "registered",
        featureId: "fixture",
        title: "Timing fixture",
        intake: null,
        threadIds: [threadId],
        targets: [{ id: "web", label: "Web" }],
        originalEstimate: { minimumMs: 60_000, maximumMs: 120_000, confidence: "low" },
      },
    },
  ],
  observations: [
    {
      threadId,
      waits: [],
      runs: [2, 4, 8].map((minutes, i) => ({
        id: `run-${i}`,
        requestedAt: at(0),
        startedAt: at(1),
        end: at(1 + minutes),
        status: "completed",
      })),
    },
  ],
};
const decodeTiming = Schema.decodeSync(TimingSchema);
function summary(input = history) {
  return decodeTiming({
    projectId,
    asOf: input.asOf,
    coverage: input.coverage,
    features: projectFeatureTiming(input).map(({ records, threadIds: _threadIds, ...feature }) => ({
      ...feature,
      records: records.map((r) => ({
        sequence: r.sequence,
        at: r.at,
        type: r.fact.type,
        reason: null,
      })),
    })),
  });
}
const member: SidebarProjectGroupMember = {
  id: projectId,
  environmentId: EnvironmentId.make("timing-environment"),
  title: "Timing fixture",
  workspaceRoot: "D:/timing-fixture",
  physicalProjectKey: "timing-fixture",
  environmentLabel: "Isolated fixture",
  defaultModelSelection: null,
  scripts: [],
  createdAt: at(0),
  updatedAt: at(0),
};
function setup() {
  state.read.mockReset();
  const registry = AtomRegistry.make();
  return { registry, [Symbol.dispose]: () => registry.dispose() };
}

it("shows the summary sample and refreshes to unavailable when run history is missing", async () => {
  using fixture = setup();
  state.read.mockResolvedValue({ _tag: "Success", value: summary() });
  await using screen = await render(
    <RegistryContext.Provider value={fixture.registry}>
      <ProjectFeatureTiming member={member} />
    </RegistryContext.Provider>,
  );
  await expect
    .element(
      screen.getByText("n = 3 · median 4m · range 2m–8m · Small sample, uncertain", {
        exact: true,
      }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByText("1m–2m · low confidence, uncalibrated", { exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByText("Includes waits · Not effort or ETA", { exact: true }))
    .toBeVisible();

  state.read.mockResolvedValue({
    _tag: "Success",
    value: summary({ ...history, observations: [] }),
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await expect
    .element(
      screen.getByText("n = 3 · median 4m · range 2m–8m · Small sample, uncertain", {
        exact: true,
      }),
    )
    .not.toBeInTheDocument();
  const row = screen
    .getByText("Observed completed run duration", { exact: true })
    .element().parentElement!;
  expect(row.textContent).toBe("Observed completed run durationUnavailable");

  state.read.mockResolvedValue({
    _tag: "Success",
    value: summary({ ...history, coverage: "incomplete" }),
  });
  await userEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }));
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("Feature history is incomplete. Timing unavailable.");
  await expect
    .element(screen.getByText("Observed completed run duration", { exact: true }))
    .not.toBeInTheDocument();
});

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
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { appAtomRegistry } from "../../rpc/atomRegistry";
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
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.read.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows the summary sample and refreshes to unavailable when run history is missing", async () => {
  state.read.mockResolvedValue({ _tag: "Success", value: summary() });
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ProjectFeatureTiming member={member} />
      </RegistryContext.Provider>,
    ),
  );
  await expect
    .element(
      page.getByText("n = 3 · median 4m · range 2m–8m · Small sample, uncertain", { exact: true }),
    )
    .toBeVisible();
  await expect
    .element(page.getByText("1m–2m · low confidence, uncalibrated", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText(/not active development effort, human work hours/))
    .toBeVisible();

  state.read.mockResolvedValue({
    _tag: "Success",
    value: summary({ ...history, observations: [] }),
  });
  await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
  await expect
    .element(
      page.getByText("n = 3 · median 4m · range 2m–8m · Small sample, uncertain", { exact: true }),
    )
    .not.toBeInTheDocument();
  const row = page
    .getByText("Observed completed run duration", { exact: true })
    .element().parentElement!;
  expect(row.textContent).toBe("Observed completed run durationUnavailable");

  state.read.mockResolvedValue({
    _tag: "Success",
    value: summary({ ...history, coverage: "incomplete" }),
  });
  await userEvent.click(page.getByRole("button", { name: "Refresh", exact: true }));
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Feature history is incomplete. Timing unavailable.");
  await expect
    .element(page.getByText("Observed completed run duration", { exact: true }))
    .not.toBeInTheDocument();
});

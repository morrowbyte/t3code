import { createFileRoute } from "@tanstack/react-router";

import { UsagePage } from "../components/usage/UsagePage";
import {
  ExecutionUsagePage,
  type ExecutionUsageSearch,
} from "../components/usage/ExecutionUsagePage";

export const Route = createFileRoute("/_chat/usage")({
  validateSearch: (search: Record<string, unknown>): ExecutionUsageSearch => ({
    view: search.view === "providers" ? "providers" : undefined,
    machine: typeof search.machine === "string" ? search.machine.slice(0, 200) : undefined,
    project: typeof search.project === "string" ? search.project.slice(0, 200) : undefined,
    thread: typeof search.thread === "string" ? search.thread.slice(0, 200) : undefined,
  }),
  component: UsageRoute,
});

function UsageRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return search.view === "providers" ? (
    <UsagePage />
  ) : (
    <ExecutionUsagePage
      search={search}
      onSearch={(next) => {
        void navigate({ search: next });
      }}
    />
  );
}

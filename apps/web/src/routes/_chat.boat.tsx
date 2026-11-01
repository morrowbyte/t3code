import { createFileRoute } from "@tanstack/react-router";
import { BoatPage, type BoatSearch } from "../components/boat/BoatPage";

export const Route = createFileRoute("/_chat/boat")({
  validateSearch: (search: Record<string, unknown>): BoatSearch => ({
    machine:
      typeof search.machine === "string" && search.machine.length > 0
        ? search.machine.slice(0, 200)
        : undefined,
    project:
      typeof search.project === "string" && search.project.length > 0
        ? search.project.slice(0, 200)
        : undefined,
    thread:
      typeof search.thread === "string" && search.thread.length > 0
        ? search.thread.slice(0, 200)
        : undefined,
    range: search.range === "day" || search.range === "week" ? search.range : ("month" as const),
  }),
  component: BoatRoute,
});

function BoatRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BoatPage
      search={search}
      onSearch={(next) => {
        void navigate({ search: next });
      }}
    />
  );
}

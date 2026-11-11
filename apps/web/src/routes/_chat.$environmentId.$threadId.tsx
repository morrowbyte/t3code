import { createFileRoute } from "@tanstack/react-router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (search: Record<string, unknown>): { requestId?: string } => ({
    ...(typeof search.requestId === "string" && search.requestId.length > 0
      ? { requestId: search.requestId }
      : {}),
  }),
  component: () => null,
});

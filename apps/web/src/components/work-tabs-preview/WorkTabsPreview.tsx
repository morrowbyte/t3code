import { Navigate, useLocation } from "@tanstack/react-router";

import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";

export type WorkTabsVariant = "b" | "c";

export function useWorkTabsPreview() {
  const hash = useLocation({ select: (location) => location.hash });
  if (!import.meta.env.DEV) return null;
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const variant = params.get("work-tabs");
  return variant === "b" || variant === "c" ? variant : null;
}

export function WorkTabsPreview({ variant }: { variant: WorkTabsVariant }) {
  const threads = useThreadShells();
  const thread = threads.find((entry) => entry.archivedAt === null);
  if (!import.meta.env.DEV || !thread) return null;
  return (
    <Navigate
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams({ environmentId: thread.environmentId, threadId: thread.id })}
      hash={`work-tabs=${variant}`}
      replace
    />
  );
}

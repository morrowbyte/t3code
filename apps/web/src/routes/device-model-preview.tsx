import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Preview = lazy(() => import("../components/device/S24ModelPreview"));

export const Route = createFileRoute("/device-model-preview")({
  validateSearch: (search: Record<string, unknown>) => ({
    view: search.view === "back" || search.view === "landscape" ? search.view : "front",
  }),
  beforeLoad: ({ context }) => {
    if (!import.meta.env.DEV) throw notFound();
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ModelPreviewRoute,
});

function ModelPreviewRoute() {
  const { view } = Route.useSearch();
  if (!import.meta.env.DEV) return null;
  return (
    <Suspense fallback={<div>Modellvorschau wird geladen…</div>}>
      <Preview key={view} initialView={view} />
    </Suspense>
  );
}

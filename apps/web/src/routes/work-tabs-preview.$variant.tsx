import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { WorkTabsPreview } from "../components/work-tabs-preview/WorkTabsPreview";

export const Route = createFileRoute("/work-tabs-preview/$variant")({
  beforeLoad: ({ context, params }) => {
    if (!import.meta.env.DEV || !["b", "c"].includes(params.variant)) throw notFound();
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WorkTabsPreviewRoute,
});

function WorkTabsPreviewRoute() {
  const { variant } = Route.useParams();
  if (variant !== "b" && variant !== "c") return null;
  return <WorkTabsPreview key={variant} variant={variant} />;
}

import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { LinkRequestCard } from "../chat/LinkRequestCard";
import { SecretRequestCard } from "../chat/SecretRequestCard";
import { getProviderStatusMessage } from "../chat/ProviderStatusBanner";
import { Button } from "../ui/button";
import { resolveAttentionRequestTarget } from "./attentionRequestTarget";

export function AttentionRequestTarget({
  requestId,
  environmentId,
  projection,
  summaries,
  deliveryFailure,
  live,
  provider,
  onOpenProviderSetup,
  onShowPending,
}: {
  requestId: string;
  environmentId: EnvironmentId;
  projection: ThreadStructure | null;
  summaries?: OrchestrationV2ThreadShell["pendingRuntimeRequests"];
  deliveryFailure?: OrchestrationV2ThreadShell["requestDeliveryFailure"];
  live: boolean;
  provider: ServerProvider | null;
  onOpenProviderSetup: (instanceId: ProviderInstanceId) => void;
  onShowPending: () => void;
}) {
  const target = resolveAttentionRequestTarget(projection, requestId, summaries, deliveryFailure);
  const title = !live
    ? "Synchronizing selected request…"
    : target.kind === "loading"
      ? "Loading selected request…"
      : target.kind === "delivery_failed"
        ? "Answer delivery not confirmed"
        : target.kind === "resolved"
          ? "This request is no longer pending."
          : target.kind === "unavailable"
            ? "The selected request could not be loaded."
            : target.kind === "runtime" && target.request.kind === "auth_refresh"
              ? "Authentication required"
              : "Selected request";
  return (
    <section
      aria-label="Selected attention request"
      className="space-y-2 border-b border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p role="status" className="text-sm text-muted-foreground">
          {title}
        </p>
        <Button size="sm" variant="outline" onClick={onShowPending}>
          Show pending requests
        </Button>
      </div>
      {live && target.kind === "delivery_failed" ? (
        <p role="alert" className="wrap-anywhere text-sm text-destructive-foreground">
          {target.failure.message}
        </p>
      ) : null}
      {live && target.kind === "card" ? (
        target.item.type === "secret_request" ? (
          <SecretRequestCard
            key={requestId}
            environmentId={environmentId}
            item={target.item}
            visibility="local"
          />
        ) : (
          <LinkRequestCard
            key={requestId}
            environmentId={environmentId}
            item={target.item}
            visibility="local"
          />
        )
      ) : null}
      {live && target.kind === "runtime" && target.request.kind === "auth_refresh" ? (
        <div className="space-y-2 text-sm">
          <p>
            {provider?.auth.status === "unauthenticated"
              ? getProviderStatusMessage(provider)
              : "Sign in on this environment to resolve this request."}
          </p>
          {provider ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onOpenProviderSetup(provider.instanceId)}
            >
              Open provider settings
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              render={<Link to="/settings/providers" search={{ environmentId }} />}
            >
              Open provider settings
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}

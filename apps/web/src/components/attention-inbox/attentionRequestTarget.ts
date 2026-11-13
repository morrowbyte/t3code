import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  OrchestrationV2PendingRuntimeRequestSummary,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { isThreadRoutePathname } from "../../threadRoutes";

export function attentionRequestFromLocation(href: string, threadRef: ScopedThreadRef) {
  const url = new URL(href, "http://t3.local");
  if (!isThreadRoutePathname(decodeURIComponent(url.pathname), threadRef)) return null;
  return url.searchParams.get("requestId") || null;
}

export function attentionRequestHref(threadRef: ScopedThreadRef, requestId?: string) {
  const path = `/${encodeURIComponent(threadRef.environmentId)}/${encodeURIComponent(threadRef.threadId)}`;
  return requestId ? `${path}?${new URLSearchParams({ requestId })}` : path;
}

export function selectAttentionRequests<Request extends { readonly requestId: string }>(
  requests: Request[],
  targetRequestId: string | null | undefined,
) {
  return targetRequestId
    ? requests.filter((request) => request.requestId === targetRequestId)
    : requests;
}

export function resolveAttentionRequestTarget(
  projection: ThreadStructure | null,
  requestId: string,
  summaries?: ReadonlyArray<OrchestrationV2PendingRuntimeRequestSummary>,
  deliveryFailure?: OrchestrationV2ThreadShell["requestDeliveryFailure"],
) {
  if (deliveryFailure?.requestId === requestId) {
    return { kind: "delivery_failed", failure: deliveryFailure } as const;
  }
  if (!projection) return { kind: "loading" } as const;
  const request = projection.runtimeRequests.find((request) => request.id === requestId);
  const failure = projection.turnItems.find(
    (item) =>
      item.id === `turn-item:runtime-request-delivery-failure:${requestId}` &&
      item.type === "error" &&
      item.status === "failed" &&
      item.title === "Answer delivery not confirmed" &&
      item.failure.class === "transport_error" &&
      request?.nodeId === item.nodeId,
  );
  if (failure?.type === "error") {
    return { kind: "delivery_failed", failure: failure.failure } as const;
  }
  if (summaries && !summaries.some((request) => request.id === requestId)) {
    return { kind: "resolved" } as const;
  }
  if (request) {
    if (request.status !== "pending") return { kind: "resolved" } as const;
    if (
      request.kind === "user_input" &&
      !projection.turnItems.some(
        (item) => item.type === "user_input_request" && item.requestId === request.id,
      )
    ) {
      return { kind: "unavailable" } as const;
    }
    return { kind: "runtime", request } as const;
  }
  const item = projection.turnItems.find(
    (item) => item.id === requestId && item.threadId === projection.thread.id,
  );
  if (item?.type === "secret_request" || item?.type === "link_request") {
    if (item.status !== "waiting") return { kind: "resolved" } as const;
    if (item.nodeId === null) return { kind: "unavailable" } as const;
    if (item.type === "secret_request") {
      if (
        !projection.runs.some(
          (run) =>
            run.id === item.runId &&
            ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      ) {
        return { kind: "resolved" } as const;
      }
    } else if (
      projection.messages.some(
        (message) =>
          message.role === "user" &&
          message.createdBy === "user" &&
          DateTime.isGreaterThan(message.updatedAt, item.startedAt ?? item.updatedAt),
      )
    ) {
      return { kind: "resolved" } as const;
    }
    return { kind: "card", item } as const;
  }
  return summaries?.some((request) => request.id === requestId)
    ? ({ kind: "unavailable" } as const)
    : ({ kind: "resolved" } as const);
}

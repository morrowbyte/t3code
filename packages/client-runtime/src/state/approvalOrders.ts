import {
  WS_METHODS,
  type ApprovalReviewOrderReadiness,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

export function createApprovalOrderEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    create: createEnvironmentRpcCommand(runtime, {
      label: "approval-review:order-create",
      tag: WS_METHODS.approvalReviewOrderCreate,
    }),
    read: createEnvironmentRpcCommand(runtime, {
      label: "approval-review:order-read",
      tag: WS_METHODS.approvalReviewOrderRead,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "approval-review:order-cancel",
      tag: WS_METHODS.approvalReviewOrderCancel,
    }),
    readiness: createEnvironmentRpcCommand(runtime, {
      label: "approval-review:order-readiness",
      tag: WS_METHODS.approvalReviewOrderReadiness,
    }),
  };
}

export function approvalOrderSourceIsReady(readiness: ApprovalReviewOrderReadiness | null) {
  return (
    readiness?.enabled === true &&
    readiness.reason === "ready" &&
    ((readiness.sourceKind === "human" && readiness.testOnly === false) ||
      (readiness.sourceKind === "synthetic" && readiness.testOnly === true))
  );
}

export function approvalOrderDestinationChannels(
  readiness: ApprovalReviewOrderReadiness | null,
  destination: ScopedThreadRef,
) {
  return (readiness?.channels ?? []).filter(
    (channel) =>
      channel.environmentId === destination.environmentId &&
      channel.threadId === destination.threadId,
  );
}

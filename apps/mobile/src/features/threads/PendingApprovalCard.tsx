import { Button } from "../../components/ui/Button";
import {
  parseApprovalReviewDetail,
  reviewBundleHasVerifiedOriginalOrder,
  type ReviewBundle,
} from "@t3tools/client-runtime/approvalReview";
import { canRespondToThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import type {
  EnvironmentId,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  RuntimeMode,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import type { PendingApproval } from "../../lib/threadActivity";
import { ApprovalReviewModal } from "./ApprovalReviewModal";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly environmentId?: EnvironmentId | undefined;
  readonly environmentLabel?: string | null | undefined;
  readonly runtimeMode?: RuntimeMode | undefined;
  readonly respondingApprovalId: RuntimeRequestId | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    packageHash?: string,
  ) => Promise<unknown>;
}
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];
const titles = {
  command: "Run a command",
  "file-read": "Read files",
  "file-change": "Change files",
  "mcp-elicitation": "Allow app access",
  permission: "Grant provider permission",
};
const modeLabels: Record<RuntimeMode, string> = {
  "approval-required": "Ask before actions",
  "auto-accept-edits": "Auto accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const [now, setNow] = useState(Date.now);
  const authority = props.approval.approvalReview;
  const expiresAt = authority?.expiresAt;
  const originalExpiresAt = authority?.originalOrder?.receipt.expiresAt;
  useEffect(() => {
    const timers = [...new Set([expiresAt, originalExpiresAt])]
      .filter((deadline): deadline is number => deadline !== undefined)
      .map((deadline) =>
        setTimeout(
          () => setNow(Date.now()),
          Math.max(0, Math.min(deadline - Date.now(), 2_147_483_647)),
        ),
      );
    return () => timers.forEach(clearTimeout);
  }, [expiresAt, originalExpiresAt]);
  const options = props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const key = `${props.environmentId ?? "unknown"}:${props.approval.requestId}`;
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  }, [props]);
  const inFlight = useRef(new Set<string>());
  const [inFlightSnapshot, setInFlightSnapshot] = useState<ReadonlySet<string>>(new Set());
  const refreshResponses = () => setInFlightSnapshot(new Set(inFlight.current));
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  const verifiedReview = useRef<ReviewBundle | null>(null);
  const [reviewFor, setReviewFor] = useState<{
    environmentId: EnvironmentId | undefined;
    requestId: RuntimeRequestId;
    detail: string | undefined;
  } | null>(null);
  if (
    reviewFor !== null &&
    (reviewFor.environmentId !== props.environmentId ||
      reviewFor.requestId !== props.approval.requestId ||
      reviewFor.detail !== props.approval.detail)
  ) {
    setReviewFor(null);
  }
  const review = useMemo(
    () => parseApprovalReviewDetail(props.approval.detail),
    [props.approval.detail],
  );
  const verifiedOriginal = useMemo(
    () =>
      review.kind === "bundle" && reviewBundleHasVerifiedOriginalOrder(review.bundle, authority),
    [review, authority],
  );
  const originalReceipt = authority?.originalOrder?.receipt;
  const originalIssue =
    originalReceipt?.version === 1
      ? "Approval disabled: legacy original orders are unverified."
      : originalReceipt?.version === 2 &&
          (originalReceipt.sourceKind === "synthetic" || originalReceipt.testOnly)
        ? "Approval disabled: synthetic test orders cannot authorize actions."
        : "Approval disabled: the original human order is missing, unverified or does not match this package.";
  const reviewIssue =
    review.kind === "bundle"
      ? review.bundle.exampleOnly
        ? "Example only. Decisions are disabled."
        : !props.approval.approvalReview
          ? "Approval disabled: this response channel cannot bind a decision to the reviewed package hash."
          : review.bundle.hash !== props.approval.approvalReview.packageHash ||
              review.bundle.target.identity !== props.approval.approvalReview.verifiedTargetId
            ? "Approval disabled: this package does not match the authoritative request."
            : !verifiedOriginal
              ? originalIssue
              : null
      : review.kind === "invalid"
        ? `Approval disabled: invalid review package. ${review.error}`
        : props.approval.approvalReview
          ? "Approval disabled: request has no review package."
          : null;
  const decisionBlocked = (decision: ProviderApprovalDecision, reviewedBundle?: ReviewBundle) => {
    if (review.kind === "bundle" && review.bundle.exampleOnly) return true;
    if (decision === "decline" || decision === "cancel") return false;
    if (review.kind === "none" && !props.approval.approvalReview) return false;
    return (
      decision !== "accept" ||
      review.kind !== "bundle" ||
      reviewedBundle !== review.bundle ||
      reviewIssue !== null
    );
  };
  const canRespond = props.approval.responseCapability !== "not_resumable";
  const disabled =
    !canRespond ||
    !props.canOperateThread ||
    props.respondingApprovalId === props.approval.requestId ||
    inFlightSnapshot.has(key);
  const respond = async (decision: ProviderApprovalDecision, reviewedBundle?: ReviewBundle) => {
    const current = latest.current;
    const packageHash = current.approval.approvalReview?.packageHash;
    if (
      current.environmentId !== props.environmentId ||
      current.approval.requestId !== props.approval.requestId ||
      current.approval.detail !== props.approval.detail ||
      current.approval.approvalReview?.packageHash !== props.approval.approvalReview?.packageHash ||
      current.onRespond !== props.onRespond ||
      !current.canOperateThread ||
      !canRespondToThreadApproval(current.approval, decision, packageHash) ||
      current.respondingApprovalId === props.approval.requestId ||
      decisionBlocked(decision, reviewedBundle) ||
      (reviewedBundle !== undefined && verifiedReview.current !== reviewedBundle) ||
      (reviewedBundle !== undefined &&
        (current.approval.approvalReview?.packageHash !== reviewedBundle.hash ||
          current.approval.approvalReview?.verifiedTargetId !== reviewedBundle.target.identity ||
          (decision === "accept" &&
            !reviewBundleHasVerifiedOriginalOrder(
              reviewedBundle,
              current.approval.approvalReview,
            )))) ||
      !(current.approval.options ?? DEFAULT_APPROVAL_OPTIONS).some(
        (option) => option.decision === decision,
      ) ||
      inFlight.current.has(key)
    )
      return;
    inFlight.current.add(key);
    refreshResponses();
    setFailedKey(null);
    const reportFailure = () => {
      if (
        latest.current.environmentId === props.environmentId &&
        latest.current.approval.requestId === props.approval.requestId &&
        latest.current.approval.detail === props.approval.detail
      )
        setFailedKey(key);
    };
    await (async () => {
      const result =
        packageHash === undefined
          ? await props.onRespond(props.approval.requestId, decision)
          : await props.onRespond(props.approval.requestId, decision, packageHash);
      if (
        result !== null &&
        typeof result === "object" &&
        "_tag" in result &&
        result._tag === "Failure"
      ) {
        reportFailure();
      }
    })()
      .catch(reportFailure)
      .finally(() => {
        inFlight.current.delete(key);
        refreshResponses();
      });
  };
  const responseControls = (reviewedBundle?: ReviewBundle) => (
    <View className="gap-3">
      {options.map((option) =>
        option.warning ? (
          <Text key={option.decision} className="text-xs leading-normal text-warning-foreground">
            {option.label}: {option.warning}
          </Text>
        ) : null,
      )}
      {!canRespond ? (
        <Text className="text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {reviewIssue ? (
        <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
          {reviewIssue}
        </Text>
      ) : null}
      {props.approval.approvalReview &&
      (props.approval.approvalReview.state !== "pending" ||
        props.approval.approvalReview.expiresAt <= now ||
        (props.approval.approvalReview.originalOrder?.receipt.expiresAt ?? Infinity) <= now) ? (
        <Text accessibilityRole="alert" className="text-sm text-warning-foreground">
          This review request is no longer pending or has expired.
        </Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2.5">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={
              disabled ||
              decisionBlocked(option.decision, reviewedBundle) ||
              !canRespondToThreadApproval(
                props.approval,
                option.decision,
                props.approval.approvalReview?.packageHash,
              )
            }
            onPress={() => void respond(option.decision, reviewedBundle)}
          />
        ))}
      </View>
      {options.length === 0 ? (
        <Text className="text-xs text-foreground-muted">
          No decisions supplied by the provider.
        </Text>
      ) : null}
      {failedKey === key ? (
        <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
          Could not submit this decision. No decision was confirmed.
        </Text>
      ) : null}
      {!props.canOperateThread ? (
        <Text className="text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </View>
  );
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row flex-wrap items-center justify-between gap-2">
        <Text className="font-t3-bold text-lg text-foreground">
          {props.approval.responseCapability === "external"
            ? "Review external action"
            : titles[props.approval.requestKind]}
        </Text>
        <Text className="font-t3-bold text-xs text-warning-foreground">
          {canRespond ? "Decision needed" : "Provider disconnected"}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-3">
        <View className="min-w-32 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">Destination environment</Text>
          <Text className="font-t3-bold text-sm text-foreground">
            {props.environmentLabel || props.environmentId || "Not supplied"}
          </Text>
        </View>
        <View className="min-w-32 flex-1 gap-1">
          <Text className="text-xs text-foreground-muted">Configured mode</Text>
          <Text className="font-t3-bold text-sm text-foreground">
            {props.runtimeMode ? modeLabels[props.runtimeMode] : "Not supplied"}
          </Text>
        </View>
      </View>
      {props.approval.appName ? (
        <Text className="text-sm text-foreground-secondary">{props.approval.appName}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-x-3 gap-y-1">
        <Text className="text-xs text-warning-foreground">Requested</Text>
        <Text className="text-xs text-foreground-muted">Execution unconfirmed</Text>
        <Text className="text-xs text-foreground-muted">Verification unconfirmed</Text>
      </View>
      <Button
        label="Open Approval Review"
        tone="secondary"
        onPress={() => {
          verifiedReview.current = null;
          setReviewFor({
            environmentId: props.environmentId,
            requestId: props.approval.requestId,
            detail: props.approval.detail,
          });
        }}
      />
      {responseControls()}
      <Button
        label={detailsFor === key ? "Hide provider details" : "Show provider details"}
        tone="secondary"
        onPress={() => setDetailsFor((current) => (current === key ? null : key))}
      />
      {detailsFor === key ? (
        <View className="gap-2 border-t border-border pt-3">
          <Text selectable className="font-mono text-sm leading-normal text-foreground-secondary">
            {props.approval.detail || "No details supplied"}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Environment ID: {props.environmentId ?? "Not supplied"}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            Request: {props.approval.requestId}
          </Text>
          <Text className="text-xs text-foreground-muted">
            Requested at: {props.approval.createdAt}
          </Text>
          <Text className="text-xs text-foreground-muted">OS privilege: Not supplied</Text>
          <Text className="text-xs text-foreground-muted">
            Effective provider policy: Not supplied
          </Text>
          <Text className="text-xs text-foreground-muted">
            Structured resource scope: Not supplied
          </Text>
        </View>
      ) : null}
      {reviewFor !== null &&
      reviewFor.environmentId === props.environmentId &&
      reviewFor.requestId === props.approval.requestId &&
      reviewFor.detail === props.approval.detail ? (
        <ApprovalReviewModal
          bundle={review.kind === "bundle" ? review.bundle : null}
          detail={props.approval.detail}
          issue={review.kind === "invalid" ? reviewIssue : null}
          environmentLabel={props.environmentLabel || props.environmentId || "Not supplied"}
          requestId={props.approval.requestId}
          authority={props.approval.approvalReview}
          renderResponseControls={(verified) =>
            responseControls(verified && review.kind === "bundle" ? review.bundle : undefined)
          }
          onVerification={(valid) => {
            verifiedReview.current = valid && review.kind === "bundle" ? review.bundle : null;
          }}
          onClose={() => {
            verifiedReview.current = null;
            setReviewFor(null);
          }}
        />
      ) : null}
    </View>
  );
}

import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { parseApprovalReviewDetail } from "@t3tools/client-runtime/approvalReview";
import type { PendingApproval } from "../../session-logic";
import { ApprovalReview } from "../approvalReview/ApprovalReview";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import { handleObjectActionKey } from "./objectKeyboardActions";

interface ComposerPendingApprovalActionsProps {
  approval?: PendingApproval | undefined;
  environmentId?: EnvironmentId | undefined;
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
    packageHash?: string,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS = [
  { decision: "cancel", label: "Cancel" },
  { decision: "decline", label: "Decline" },
  { decision: "acceptForSession", label: "Always allow this session" },
  { decision: "accept", label: "Approve" },
] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  approval,
  environmentId,
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const review = parseApprovalReviewDetail(approval?.detail);
  const blockedExample = review.kind === "bundle" && review.bundle.exampleOnly;
  const decisionBlocked = (decision: ProviderApprovalDecision) =>
    blockedExample || (review.kind !== "none" && decision !== "decline" && decision !== "cancel");
  const latest = useRef({
    detail: approval?.detail,
    requestId,
    disabled,
    isResponding,
    canRespond,
    options,
    onRespondToApproval,
  });
  useLayoutEffect(() => {
    latest.current = {
      detail: approval?.detail,
      requestId,
      disabled,
      isResponding,
      canRespond,
      options,
      onRespondToApproval,
    };
  });
  const inFlight = useRef(new Map<RuntimeRequestId, Set<typeof onRespondToApproval>>());
  const [inFlightSnapshot, setInFlightSnapshot] = useState<
    ReadonlyMap<RuntimeRequestId, ReadonlySet<typeof onRespondToApproval>>
  >(new Map());
  const refreshResponses = () =>
    setInFlightSnapshot(
      new Map([...inFlight.current].map(([id, responders]) => [id, new Set(responders)])),
    );
  const [failedRequest, setFailedRequest] = useState<{
    requestId: RuntimeRequestId;
    responder: typeof onRespondToApproval;
  } | null>(null);
  const responseDisabled =
    disabled ||
    isResponding ||
    !canRespond ||
    inFlightSnapshot.get(requestId)?.has(onRespondToApproval) === true;
  const respond = async (decision: ProviderApprovalDecision) => {
    const current = latest.current;
    if (
      current.requestId !== requestId ||
      current.detail !== approval?.detail ||
      decisionBlocked(decision) ||
      current.onRespondToApproval !== onRespondToApproval ||
      current.disabled ||
      current.isResponding ||
      !current.canRespond ||
      !current.options.some((option) => option.decision === decision) ||
      inFlight.current.get(requestId)?.has(onRespondToApproval) === true
    )
      return;
    let requests = inFlight.current.get(requestId);
    if (!requests) inFlight.current.set(requestId, (requests = new Set()));
    requests.add(onRespondToApproval);
    refreshResponses();
    setFailedRequest(null);
    await (async () => {
      if (approval?.approvalReview)
        await onRespondToApproval(requestId, decision, approval.approvalReview.packageHash);
      else await onRespondToApproval(requestId, decision);
    })()
      .catch(() => {
        if (
          latest.current.requestId === requestId &&
          latest.current.onRespondToApproval === onRespondToApproval
        )
          setFailedRequest({ requestId, responder: onRespondToApproval });
      })
      .finally(() => {
        const requests = inFlight.current.get(requestId);
        requests?.delete(onRespondToApproval);
        if (requests?.size === 0) inFlight.current.delete(requestId);
        refreshResponses();
      });
  };
  const primaryOptions = options.filter(
    (option) => option.decision === "decline" || option.decision === "accept",
  );
  const moreOptions = options.filter(
    (option) => option.decision !== "decline" && option.decision !== "accept",
  );

  return (
    <div
      data-keyboard-object="Approval"
      role="group"
      tabIndex={-1}
      aria-label="Approval decisions"
      className="flex flex-wrap items-center gap-1"
      onKeyDown={(event) =>
        handleObjectActionKey(event, { a: "approve", d: "decline", m: "scope" })
      }
    >
      {approval ? (
        <>
          <Button
            variant="outline"
            size="xs"
            data-keyboard-action="review"
            onClick={() => setReviewOpen(true)}
          >
            Review action
          </Button>
          <ApprovalReview
            approval={approval}
            environmentId={environmentId}
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            onRespond={onRespondToApproval}
            disabled={responseDisabled}
          />
        </>
      ) : null}
      {primaryOptions.map((option) => {
        const button = (
          <Button
            key={option.decision}
            size="xs"
            variant={option.decision === "accept" ? "default" : "outline"}
            disabled={responseDisabled || decisionBlocked(option.decision)}
            aria-description={option.warning}
            data-keyboard-action={option.decision === "accept" ? "approve" : "decline"}
            data-keyboard-primary={option.decision === "accept" ? true : undefined}
            aria-keyshortcuts={option.decision === "accept" ? "A" : "D"}
            onClick={() => {
              void respond(option.decision);
            }}
          >
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span className="max-w-40 whitespace-normal wrap-break-word">{option.label}</span>
          </Button>
        );
        return option.warning ? (
          <Tooltip key={option.decision}>
            <TooltipTrigger render={button} />
            <TooltipPopup side="top">{option.warning}</TooltipPopup>
          </Tooltip>
        ) : (
          button
        );
      })}
      {moreOptions.length > 0 ? (
        <Menu>
          <MenuTrigger
            disabled={responseDisabled}
            render={
              <Button
                size="icon-xs"
                variant="outline"
                aria-label="More approval options"
                data-keyboard-action="scope"
                aria-keyshortcuts="M"
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
            {moreOptions.map((option) => {
              const item = (
                <MenuItem
                  key={option.decision}
                  disabled={responseDisabled || decisionBlocked(option.decision)}
                  aria-description={option.warning}
                  onClick={() => {
                    void respond(option.decision);
                  }}
                >
                  {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                  <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
                </MenuItem>
              );
              return option.warning ? (
                <Tooltip key={option.decision}>
                  <TooltipTrigger render={item} />
                  <TooltipPopup side="top">{option.warning}</TooltipPopup>
                </Tooltip>
              ) : (
                item
              );
            })}
          </MenuPopup>
        </Menu>
      ) : null}
      {failedRequest?.requestId === requestId && failedRequest.responder === onRespondToApproval ? (
        <span role="status" className="text-xs text-destructive">
          Could not send this decision. The request is still pending.
        </span>
      ) : null}
    </div>
  );
});

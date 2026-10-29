import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useStableCallback } from "../../hooks/useStableCallback";
import { parseApprovalReviewDetail } from "@t3tools/client-runtime/approvalReview";
import type { PendingApproval } from "../../session-logic";
import { ApprovalReview } from "../approvalReview/ApprovalReview";
import { memo, useLayoutEffect, useRef, useState } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import { handleObjectActionKey } from "./objectKeyboardActions";

interface ComposerPendingApprovalActionsProps {
  approval?: PendingApproval | undefined;
  environmentId?: EnvironmentId | undefined;
  threadId?: ThreadId | null | undefined;
  targetLabel?: string | undefined;
  presentation?: "composer" | "inline";
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
  threadId,
  targetLabel,
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options = DEFAULT_APPROVAL_OPTIONS,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const [reviewOpen, setReviewOpen] = useState(false);
  const [desktopRouteError, setDesktopRouteError] = useState<{
    requestId: RuntimeRequestId;
    message: string;
  } | null>(null);
  const respondToDecision: typeof onRespondToApproval = useStableCallback(
    async (id, decision, hash) => {
      if (!approval?.privilegedCommand || !window.desktopBridge) {
        return hash === undefined
          ? onRespondToApproval(id, decision)
          : onRespondToApproval(id, decision, hash);
      }
      if (
        !environmentId ||
        !threadId ||
        !hash ||
        (decision !== "accept" && decision !== "decline")
      ) {
        throw new Error(
          "Desktop privileged approval requires a matching environment, thread and hash.",
        );
      }
      setDesktopRouteError(null);
      try {
        return await window.desktopBridge.respondToPrivilegedDecision({
          environmentId,
          threadId,
          requestId: id,
          packageHash: hash,
          decision,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "";
        if (detail.includes("DPoP signer")) {
          return await onRespondToApproval(id, decision, hash);
        }
        const messages = [
          "T3 Connect approval requires the renderer-bound DPoP signer; this route is not yet supported by the desktop approval transport.",
          "The saved T3 Connect route requires the renderer-bound DPoP signer; this route is not yet supported by the desktop approval transport.",
          "The saved target environment is disabled.",
          "The saved route has no authenticated bearer session.",
          "The saved SSH route could not be connected.",
          "The saved HTTP and WebSocket routes do not share a safe origin.",
          "Target environment mismatch.",
        ];
        const message = messages.find((item) => detail.includes(item));
        if (message) {
          setDesktopRouteError({
            requestId: id,
            message: message.includes("DPoP signer")
              ? "Desktop approval over T3 Connect is not supported yet. Use a saved direct or SSH connection."
              : message,
          });
          setReviewOpen(false);
        }
        throw error;
      }
    },
  );
  const scopedOptions = approval?.privilegedCommand
    ? options.filter((option) => option.decision === "accept" || option.decision === "decline")
    : options;
  const review = parseApprovalReviewDetail(approval?.detail);
  const blockedExample = review.kind === "bundle" && review.bundle.exampleOnly;
  const decisionBlocked = (decision: ProviderApprovalDecision) =>
    blockedExample ||
    ((review.kind !== "none" || approval?.privilegedCommand !== undefined) &&
      decision !== "decline" &&
      decision !== "cancel");
  const latest = useRef({
    detail: approval?.detail,
    privilegedCommand: approval?.privilegedCommand,
    requestId,
    disabled,
    isResponding,
    canRespond,
    options: scopedOptions,
    onRespondToApproval,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds asynchronous decisions to the committed approval and responder
  useLayoutEffect(() => {
    latest.current = {
      detail: approval?.detail,
      privilegedCommand: approval?.privilegedCommand,
      requestId,
      disabled,
      isResponding,
      canRespond,
      options: scopedOptions,
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
      current.privilegedCommand !== approval?.privilegedCommand ||
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
      if (approval?.privilegedCommand)
        await respondToDecision(requestId, decision, approval.privilegedCommand.packageHash);
      else if (approval?.approvalReview)
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
  const primaryOptions = scopedOptions.filter(
    (option) =>
      option.decision === "decline" ||
      (option.decision === "accept" && !approval?.privilegedCommand),
  );
  const moreOptions = scopedOptions.filter(
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
          {presentation === "inline" ? (
            <InlineButton
              tone="muted"
              data-keyboard-action="review"
              onClick={() => setReviewOpen(true)}
            >
              Review action
            </InlineButton>
          ) : (
            <Button
              variant="outline"
              size="xs"
              data-keyboard-action="review"
              onClick={() => setReviewOpen(true)}
            >
              Review action
            </Button>
          )}
          <ApprovalReview
            approval={approval}
            privilegedCommand={approval.privilegedCommand}
            environmentId={environmentId}
            targetLabel={targetLabel}
            open={reviewOpen}
            onOpenChange={setReviewOpen}
            onRespond={respondToDecision}
            disabled={responseDisabled}
          />
        </>
      ) : null}
      {primaryOptions.map((option) => {
        const buttonProps = {
          disabled: responseDisabled || decisionBlocked(option.decision),
          "aria-description": option.warning,
          "data-keyboard-action": option.decision === "accept" ? "approve" : "decline",
          "data-keyboard-primary": option.decision === "accept" ? true : undefined,
          "aria-keyshortcuts": option.decision === "accept" ? "A" : "D",
          onClick: () => {
            void respond(option.decision);
          },
        };
        const content = (
          <>
            {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
            <span
              className={
                presentation === "inline"
                  ? "whitespace-normal"
                  : "max-w-40 whitespace-normal wrap-break-word"
              }
            >
              {option.label}
            </span>
          </>
        );
        const button =
          presentation === "inline" ? (
            <InlineButton
              key={option.decision}
              {...buttonProps}
              tone={option.decision === "accept" ? "default" : "muted"}
            >
              {content}
            </InlineButton>
          ) : (
            <Button
              key={option.decision}
              {...buttonProps}
              size="xs"
              variant={option.decision === "accept" ? "default" : "outline"}
            >
              {content}
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
              presentation === "inline" ? (
                <InlineButton
                  tone="muted"
                  aria-label="More approval options"
                  data-keyboard-action="scope"
                  aria-keyshortcuts="M"
                />
              ) : (
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="More approval options"
                  data-keyboard-action="scope"
                  aria-keyshortcuts="M"
                />
              )
            }
          >
            {presentation === "inline" ? "More" : <EllipsisIcon />}
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
      {desktopRouteError?.requestId === requestId ? (
        <span role="status" className="text-xs text-destructive">
          {desktopRouteError.message}
        </span>
      ) : null}
      {failedRequest?.requestId === requestId &&
      failedRequest.responder === onRespondToApproval &&
      desktopRouteError?.requestId !== requestId ? (
        <span role="status" className="text-xs text-destructive">
          {approval?.privilegedCommand
            ? "Could not confirm this decision. Check the request before trying again."
            : "Could not send this decision. The request is still pending."}
        </span>
      ) : null}
    </div>
  );
});

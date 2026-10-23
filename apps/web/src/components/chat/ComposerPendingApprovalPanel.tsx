import type { EnvironmentId, RuntimeMode, RuntimeRequestId } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { ApprovalActionSummary } from "./ApprovalActionSummary";
import { Button } from "../ui/button";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  pendingIndex?: number;
  approvals?: readonly PendingApproval[];
  onSelectRequest?: (requestId: RuntimeRequestId) => void;
  environmentId?: EnvironmentId | undefined;
  runtimeMode?: RuntimeMode | undefined;
  className?: string;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel(
  props: ComposerPendingApprovalPanelProps,
) {
  const { approvals, onSelectRequest, pendingIndex = 0, ...summary } = props;
  return (
    <>
      <ApprovalActionSummary {...summary} pendingIndex={pendingIndex} />
      {props.approval.fullAccessOverride ? (
        <Popover>
          <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
            {FULL_ACCESS_OVERRIDE_QUESTION}
          </PopoverTrigger>
          <PopoverPopup
            {...composerFloatingLayerProps}
            aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
            tooltipStyle
            side="top"
            className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
          >
            {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
          </PopoverPopup>
        </Popover>
      ) : null}
      {approvals && approvals.length > 1 && onSelectRequest ? (
        <nav aria-label="Pending approvals" className="mt-2 flex gap-2">
          <Button
            variant="outline"
            size="icon-xl"
            aria-label="Previous pending approval"
            onClick={() =>
              onSelectRequest(
                approvals[(pendingIndex - 1 + approvals.length) % approvals.length]!.requestId,
              )
            }
          >
            ←
          </Button>
          <Button
            variant="outline"
            size="icon-xl"
            aria-label="Next pending approval"
            onClick={() =>
              onSelectRequest(approvals[(pendingIndex + 1) % approvals.length]!.requestId)
            }
          >
            →
          </Button>
        </nav>
      ) : null}
    </>
  );
});

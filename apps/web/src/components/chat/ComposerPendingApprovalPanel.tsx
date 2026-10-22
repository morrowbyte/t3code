import type { EnvironmentId, RuntimeMode, RuntimeRequestId } from "@t3tools/contracts";
import { memo } from "react";
import { type PendingApproval } from "../../session-logic";
import { ApprovalActionSummary } from "./ApprovalActionSummary";
import { Button } from "../ui/button";

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

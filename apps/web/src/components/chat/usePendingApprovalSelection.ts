import { useState } from "react";
import type { RuntimeRequestId } from "@t3tools/contracts";
import type { PendingApproval } from "../../session-logic";

export function usePendingApprovalSelection(
  approvals: readonly PendingApproval[],
  preferred: PendingApproval | null,
) {
  const [selectedId, selectApproval] = useState<RuntimeRequestId | null>(null);
  return {
    selectedApproval: approvals.find((approval) => approval.requestId === selectedId) ?? preferred,
    selectApproval,
  };
}

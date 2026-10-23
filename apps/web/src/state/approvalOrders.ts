import { createApprovalOrderEnvironmentAtoms } from "@t3tools/client-runtime/state/approval-orders";

import { connectionAtomRuntime } from "../connection/runtime";

export const approvalOrderEnvironment = createApprovalOrderEnvironmentAtoms(connectionAtomRuntime);

import type { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";

// Transport-authenticated credentials only: this does not prove human message authorship.
// Host-order creation has its own explicitly pinned human ingress; general RPC metadata cannot create an order.
export class ApprovalReviewHumanAuthority extends Context.Reference<
  | {
      readonly sessionId: AuthSessionId;
      readonly subject: string;
    }
  | undefined
>("t3/auth/ApprovalReviewHumanAuthority", { defaultValue: () => undefined }) {}

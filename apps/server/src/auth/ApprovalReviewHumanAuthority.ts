import type { AuthSessionId } from "@t3tools/contracts";
import * as Context from "effect/Context";

// Only authenticated transport middleware supplies this; it never comes from command payloads.
export class ApprovalReviewHumanAuthority extends Context.Reference<
  | {
      readonly sessionId: AuthSessionId;
      readonly subject: string;
    }
  | undefined
>("t3/auth/ApprovalReviewHumanAuthority", { defaultValue: () => undefined }) {}

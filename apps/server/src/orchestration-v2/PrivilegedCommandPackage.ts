import type { PrivilegedCommandBundle } from "@t3tools/contracts";
import { canonical, hash } from "./ApprovalReviewPackage.ts";

/** Hash the complete identity and the exact UTF-8 script, without normalization. */
export function privilegedCommandHash(requestId: string, bundle: PrivilegedCommandBundle): string {
  return hash(canonical({ version: 1, requestId, ...bundle }));
}

export function isValidPrivilegedCommand(bundle: PrivilegedCommandBundle): boolean {
  return (
    bundle.purpose.trim().length > 0 &&
    bundle.purpose.isWellFormed() &&
    bundle.script.isWellFormed() &&
    !bundle.script.includes("\0") &&
    bundle.cwd.isWellFormed() &&
    !bundle.cwd.includes("\0")
  );
}

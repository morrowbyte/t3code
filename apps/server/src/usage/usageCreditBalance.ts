import type { ServerProviderUsageLimits } from "@t3tools/contracts";

export function codexCreditBalance(
  credits:
    | {
        readonly balance?: string | null | undefined;
        readonly unlimited: boolean;
        readonly hasCredits: boolean;
      }
    | null
    | undefined,
  checkedAt: string,
): ServerProviderUsageLimits["creditBalance"] {
  if (!credits) return undefined;
  const balance = credits.balance?.trim();
  return {
    checkedAt,
    unlimited: credits.unlimited,
    hasCredits: credits.hasCredits,
    ...(balance && balance.length <= 64 && /^-?\d+(?:\.\d+)?$/.test(balance) ? { balance } : {}),
  };
}

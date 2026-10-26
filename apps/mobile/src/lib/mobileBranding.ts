export const CREW_COLORS = {
  ink: "#292B2E",
  paper: "#F2F1EC",
  accent: "#789C90",
} as const;

export type MobileStageLabel = "Dev" | "Preview" | null;

export function resolveMobileStageLabel(appVariant: unknown): MobileStageLabel {
  if (appVariant === "development") return "Dev";
  if (appVariant === "preview") return "Preview";
  return null;
}

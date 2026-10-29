import type { ProjectIconColor, ProjectIconOverride } from "@t3tools/contracts";

export type { AgentIdentityTheme } from "@t3tools/contracts";
export { deriveAgentIdentity } from "@t3tools/shared/agentIdentity";

const PROJECT_COLORS = {
  gray: "#6b7280",
  red: "#ef4444",
  orange: "#f97316",
  amber: "#f59e0b",
  yellow: "#eab308",
  lime: "#84cc16",
  green: "#22c55e",
  emerald: "#10b981",
  teal: "#14b8a6",
  cyan: "#06b6d4",
  sky: "#0ea5e9",
  blue: "#3b82f6",
  indigo: "#6366f1",
  violet: "#8b5cf6",
  purple: "#a855f7",
  fuchsia: "#d946ef",
  pink: "#ec4899",
  rose: "#f43f5e",
} as const satisfies Record<ProjectIconColor, string>;
const PROJECT_COLOR_NAMES = Object.keys(PROJECT_COLORS) as ProjectIconColor[];

export function resolveAgentProjectColor(
  project: {
    readonly title: string;
    readonly projectIcon?: ProjectIconOverride | null | undefined;
  } | null,
) {
  if (!project) return PROJECT_COLORS.gray;
  if (project.projectIcon?.kind === "monogram" || project.projectIcon?.kind === "lucide") {
    return PROJECT_COLORS[project.projectIcon.color];
  }
  // Match the default project icon's title-derived color when no color override exists.
  const seed = project.title.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_COLOR_NAMES.length;
  }
  return PROJECT_COLORS[PROJECT_COLOR_NAMES[index] ?? "blue"];
}

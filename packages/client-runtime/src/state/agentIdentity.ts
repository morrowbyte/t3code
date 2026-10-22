import type {
  OrchestrationV2AppThreadLineage,
  ProjectIconColor,
  ProjectIconOverride,
  ScopedThreadRef,
} from "@t3tools/contracts";

export type AgentIdentityTheme = "neutral" | "weasel";

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

const GIVEN_NAMES = [
  "Mika",
  "Nori",
  "Pip",
  "Lumi",
  "Tavi",
  "Remy",
  "Kira",
  "Juno",
  "Fenn",
  "Milo",
  "Nika",
  "Ari",
  "Timo",
  "Yuki",
  "Rumi",
  "Lio",
] as const;

const FAMILY_STEMS = [
  "Sommer",
  "Winter",
  "Linden",
  "Rosen",
  "Birken",
  "Eichen",
  "Weiden",
  "Fichten",
  "Buchen",
  "Sonnen",
  "Morgen",
  "Abend",
  "Wiesen",
  "Hasel",
  "Falken",
  "Erlen",
] as const;

const FAMILY_ENDINGS = [
  "feld",
  "bach",
  "hain",
  "hof",
  "wald",
  "berg",
  "tal",
  "stein",
  "brunn",
  "au",
  "born",
  "beck",
  "holz",
  "mann",
  "ried",
  "horst",
] as const;

function identityHash(key: string, seed: number) {
  let hash = seed;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function deriveAgentIdentity(
  ref: ScopedThreadRef,
  lineage?: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent"> | null,
  theme: AgentIdentityTheme = "neutral",
) {
  const key = JSON.stringify([ref.environmentId, ref.threadId]);
  const hash = identityHash(key, 2166136261);
  const secondHash = identityHash(key, 3339675911);
  // Human aliases can repeat. The scoped key and display reference disambiguate
  // them in details without making names depend on which peers a client loaded.
  const discriminator = `${hash.toString(36)}-${secondHash.toString(36)}`;
  const name = `${GIVEN_NAMES[hash % GIVEN_NAMES.length]} ${FAMILY_STEMS[(hash >>> 4) % FAMILY_STEMS.length]}${FAMILY_ENDINGS[secondHash % FAMILY_ENDINGS.length]}`;
  const role =
    lineage?.relationshipToParent === "subagent"
      ? "Subagent"
      : lineage?.relationshipToParent === "fork"
        ? "Fork-Agent"
        : lineage
          ? "Hauptagent"
          : "Agent";
  return {
    key,
    discriminator,
    name,
    role,
    label: name,
    icon: theme === "weasel" ? ("weasel" as const) : ("agent" as const),
    accent: hash % 6,
    // Keep the same portrait across renames, lineage changes and client reloads.
    avatarVariant: (hash >>> 8) % 4,
  };
}

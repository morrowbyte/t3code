import type { OrchestrationV2AppThreadLineage, ScopedThreadRef } from "@t3tools/contracts";

export type AgentIdentityTheme = "neutral" | "weasel";

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
    label: `${name} · ${role}`,
    icon: theme === "weasel" ? ("weasel" as const) : ("agent" as const),
    accent: hash % 6,
  };
}

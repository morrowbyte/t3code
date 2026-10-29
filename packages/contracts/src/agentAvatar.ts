import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AGENT_IDENTITY_THEMES = {
  neutral: {
    nameEndings: null,
    messageTraits: "friendly, calm and direct",
    label: "Neutral",
    glyph: null,
    avatarPrompt: "a distinctive friendly individual character, polished illustrated portrait",
  },
  weasel: {
    nameEndings: ["Flinkpfote", "Wieselflink", "Wuselbart", "Sprungnase"],
    messageTraits: "nimble, curious and lightly playful",
    label: "Helferwiesel",
    glyph: null,
    avatarPrompt: "a distinctive expressive weasel character, illustrated portrait",
  },
  dog: {
    nameEndings: ["Spürnase", "Wedelpfote", "Treupfote", "Wachnase"],
    messageTraits: "warm, loyal and encouraging",
    label: "Hund",
    glyph: "🐶",
    avatarPrompt: "a distinctive expressive dog character, illustrated portrait",
  },
  cat: {
    nameEndings: ["Samtpfote", "Schnurrbart", "Mondkralle", "Seidenfell"],
    messageTraits: "observant, independent and quietly witty",
    label: "Katze",
    glyph: "🐱",
    avatarPrompt: "a distinctive expressive cat character, illustrated portrait",
  },
  fox: {
    nameEndings: ["Rotpfote", "Schlauschweif", "Fuchsfährte", "Buschschwanz"],
    messageTraits: "resourceful, perceptive and lightly witty",
    label: "Fuchs",
    glyph: "🦊",
    avatarPrompt: "a distinctive expressive fox character, illustrated portrait",
  },
  otter: {
    nameEndings: ["Flusspfote", "Kieselbart", "Wellenreiter", "Ufertaucher"],
    messageTraits: "sociable, inventive and cheerful",
    label: "Otter",
    glyph: "🦦",
    avatarPrompt: "a distinctive expressive otter character, illustrated portrait",
  },
  raccoon: {
    nameEndings: ["Maskenpfote", "Nachtstreifer", "Waschpfote", "Ringelschweif"],
    messageTraits: "practical, inquisitive and good-humored",
    label: "Waschbär",
    glyph: "🦝",
    avatarPrompt: "a distinctive expressive raccoon character, illustrated portrait",
  },
  owl: {
    nameEndings: ["Federflug", "Nachtblick", "Leiseflügel", "Eulenauge"],
    messageTraits: "thoughtful, patient and precise",
    label: "Eule",
    glyph: "🦉",
    avatarPrompt: "a distinctive expressive owl character, illustrated portrait",
  },
  raven: {
    nameEndings: ["Rabenschwinge", "Schwarzfeder", "Rabenblick", "Nachtflügel"],
    messageTraits: "perceptive, concise and dryly witty",
    label: "Rabe",
    glyph: "🐦‍⬛",
    avatarPrompt: "a distinctive expressive raven character, illustrated portrait",
  },
  "red-panda": {
    nameEndings: ["Ringelschwanz", "Rotfell", "Bambuspfote", "Klettertatze"],
    messageTraits: "gentle, curious and quietly upbeat",
    label: "Rotpanda",
    glyph: "🐼",
    avatarPrompt:
      "a distinctive expressive red panda character with reddish fur and a ringed tail, illustrated portrait",
  },
  capybara: {
    nameEndings: ["Uferfreund", "Ruhepfote", "Wasserbart", "Sonnenruhe"],
    messageTraits: "calm, sociable and reassuring",
    label: "Capybara",
    glyph: "🐹",
    avatarPrompt:
      "a distinctive expressive capybara character with a broad muzzle and small rounded ears, illustrated portrait",
  },
  bear: {
    nameEndings: ["Brummtatze", "Honigpfote", "Bärenmut", "Waldtatze"],
    messageTraits: "steady, warm and practical",
    label: "Bär",
    glyph: "🐻",
    avatarPrompt: "a distinctive expressive bear character, illustrated portrait",
  },
  turtle: {
    nameEndings: ["Panzerpfad", "Moosrücken", "Ruheschritt", "Schildblick"],
    messageTraits: "patient, methodical and quietly confident",
    label: "Schildkröte",
    glyph: "🐢",
    avatarPrompt:
      "a distinctive expressive turtle character with a visible shell, illustrated portrait",
  },
} as const;

export const AgentIdentityTheme = Schema.Literals(
  Object.keys(AGENT_IDENTITY_THEMES) as Array<keyof typeof AGENT_IDENTITY_THEMES>,
);
export type AgentIdentityTheme = typeof AgentIdentityTheme.Type;

export const AGENT_IDENTITY_THEME_OPTIONS = Object.entries(AGENT_IDENTITY_THEMES).map(
  ([value, { label }]) => ({ value: value as AgentIdentityTheme, label }),
);

export const AgentAvatarKey = Schema.Struct({
  threadId: ThreadId,
  theme: AgentIdentityTheme,
});
export type AgentAvatarKey = typeof AgentAvatarKey.Type;

export const AgentAvatarGenerateInput = Schema.Struct({
  ...AgentAvatarKey.fields,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  regenerate: Schema.optional(Schema.Boolean),
});
export type AgentAvatarGenerateInput = typeof AgentAvatarGenerateInput.Type;

export const AgentAvatarState = Schema.Struct({
  ...AgentAvatarKey.fields,
  status: Schema.Literals(["missing", "generating", "ready", "failed", "cancelled"]),
  attachmentId: Schema.NullOr(Schema.String),
  mimeType: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type AgentAvatarState = typeof AgentAvatarState.Type;

export class AgentAvatarError extends Schema.TaggedError<AgentAvatarError>()("AgentAvatarError", {
  message: Schema.String,
}) {}

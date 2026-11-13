import {
  DESKTOP_PET_SUMMARIES,
  MAX_DESKTOP_PET_SUMMARY_LENGTH,
  type DesktopPetItemKind,
} from "@t3tools/contracts";

const sensitive =
  /\b(?:password|passphrase|passwd|credential\w*|secret\w*|token\w*|bearer|cookie|session[ -]?id|api[ -]?key|auth(?:entication|orization)?|verification[ -]?code|one[ -]?time|otp|totp|recovery[ -]?(?:code|key)|private[ -]?key|pin|passwort|kennwort|geheim\w*|zugangscode|bestätigungscode)\b/i;
const unsafeControls =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function publicExcerpt(value: string | undefined) {
  if (!value || value.length > 32_768 || unsafeControls.test(value)) return "";
  const prose = value
    .replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/!\[[^\]\n]*\]\([^\n]*?\)/g, "")
    .replace(/\[([^\]\n]*)\]\([^\n]*?\)/g, "$1")
    .replace(/^\s*\[[^\]]+\]:.*$/gm, "")
    .replace(/\b[a-z][\w+.-]*:\/\/\S+/gi, "")
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "")
    .replace(/\b[\w.-]+\.[a-z]{2,}(?:[/#?]\S*)?/gi, "")
    .replace(/(?:^|[\s(])(?:[a-z]:[\\/]|~?\/)[^\s)]*/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_~]/g, "")
    .trim();
  // Only published prose enters here; links, code and credential-like text stay in the thread.
  if (sensitive.test(prose) || /\b[A-Za-z0-9_+/=-]{24,}\b/.test(prose)) return "";
  return (prose.split(/\n\s*\n/)[0] ?? "")
    .replace(/\b\d{4,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
}

export function petSummary(kind: DesktopPetItemKind, threadNumber: number, publicText?: string) {
  const excerpt = kind === "approval" ? "" : publicExcerpt(publicText);
  const summary = `Thread ${threadNumber} · ${
    excerpt
      ? `${kind === "question" ? "Question" : "Result"}: ${excerpt}`
      : DESKTOP_PET_SUMMARIES[kind]
  }`;
  if (summary.length <= MAX_DESKTOP_PET_SUMMARY_LENGTH) return summary;
  return `${summary.slice(0, MAX_DESKTOP_PET_SUMMARY_LENGTH - 1).replace(/[\ud800-\udbff]$/, "")}…`;
}

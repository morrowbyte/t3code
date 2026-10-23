import { expect, it } from "vite-plus/test";
import { delegatedTaskStatus } from "./subagentDisplay.ts";

it.each([
  ["pending", null, "In Warteschlange"],
  ["running", null, "Wird ausgeführt"],
  ["waiting", null, "Wartet auf Rückmeldung"],
  ["completed", null, "Abgeschlossen"],
  ["completed", "  ", "Abgeschlossen"],
  ["completed", "Child task ended with status completed", "Abgeschlossen"],
  ["completed", "The comparison is ready.", "Ergebnis verfügbar"],
  ["failed", "The subprocess failed.", "Fehlgeschlagen"],
  ["cancelled", null, "Gestoppt"],
  ["interrupted", null, "Unterbrochen"],
  ["idle", null, "Inaktiv"],
] as const)("shows %s with result %s as %s", (status, result, label) => {
  expect(delegatedTaskStatus({ status, result }).label).toBe(label);
});

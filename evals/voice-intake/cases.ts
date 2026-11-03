import type { VoiceIntakeSnapshot } from "../../packages/contracts/src/voiceIntake.ts";

type Intent = VoiceIntakeSnapshot["intents"][number];
export type IntakeCase = {
  id: string;
  optIn?: true;
  source: string;
  rubric: string;
  segments: VoiceIntakeSnapshot["segments"];
  intents: ReadonlyArray<Intent>;
  rejections?: VoiceIntakeSnapshot["rejections"];
  conversationContext?: VoiceIntakeSnapshot["conversationContext"];
  expected: {
    type: "new" | "refine" | "reference" | "conversation";
    intentId?: string;
    readOnly?: boolean;
    required: ReadonlyArray<RegExp>;
    forbidden: ReadonlyArray<RegExp>;
  };
};

const segment = (id: string, text: string, final = false) => ({
  id,
  text,
  final,
  revision: 2,
  stopId: null,
});
const reportRequest =
  "Erstelle einen lokalen Wochenbericht für meinen Chef aus diesen fiktiven Zahlen: Montag 8, Dienstag 3, Mittwoch 2 erledigte Aufgaben.";
const oldSegment = segment("report-authorized", reportRequest, true);
const report: Intent = {
  id: "report-running",
  request: reportRequest,
  provisional: false,
  status: "running",
  result: null,
  sources: [
    {
      segmentId: oldSegment.id,
      revision: 2,
      start: 0,
      end: reportRequest.length,
      quote: reportRequest,
    },
  ],
};
const chartRequest =
  "Erstelle aus den fiktiven Aufgabenzahlen Montag 8, Dienstag 3 und Mittwoch 2 ein Balkendiagramm hier im Chat.";
const rejectedChart = {
  requestId: "previous-chart-proposal",
  snapshotVersion: 1,
  actionIndex: 0,
  anchorIndex: null,
  actionType: "new",
  code: "snapshot_retracted",
  disposition: "not_applied" as const,
  sources: [{ segmentId: "chart-request", revision: 2, quote: chartRequest }],
};

export const cases: ReadonlyArray<IntakeCase> = [
  {
    id: "prefinal-complete-clause",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic learning document",
    rubric:
      "Start the complete reversible learning-document request before ASR final, omit the unfinished trailing clause.",
    segments: [
      segment(
        "learning-now",
        "Erstelle im aktuellen Projekt ein lokales Markdown-Dokument mit einem Lernplan für Rustlings: drei kurze Übungseinheiten, jeweils mit einem Lernziel. Und wenn wir danach noch",
      ),
    ],
    intents: [],
    expected: {
      type: "new",
      readOnly: false,
      required: [/rustlings/i, /drei|3/i, /markdown/i],
      forbidden: [/veröffent|publish|deploy|senden|\bsend\b/i],
    },
  },
  {
    id: "refine-exact-running-intent",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic manager report",
    rubric:
      "Steer report-running exactly once, adding the requested bar chart without another task or external delivery.",
    segments: [
      oldSegment,
      segment(
        "report-correction",
        "Korrektur zum laufenden Wochenbericht: Ergänze ein Balkendiagramm mit genau diesen drei Tageswerten. Bitte nichts an meinen Chef senden.",
      ),
    ],
    intents: [report],
    expected: {
      type: "refine",
      intentId: report.id,
      readOnly: false,
      required: [/balken|bar\s*chart/i, /drei|3|tageswert/i],
      forbidden: [],
    },
  },
  {
    id: "knowledge-stays-conversation",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic common-knowledge question",
    rubric:
      "Leave a self-contained common-knowledge question in the conversation, without any work action.",
    segments: [
      segment(
        "knowledge-now",
        "Was ist eigentlich der Unterschied zwischen Mittelwert und Median? Erklär es mir kurz.",
        true,
      ),
    ],
    intents: [],
    expected: { type: "conversation", required: [], forbidden: [] },
  },
  {
    id: "independent-current-research",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic colleague research",
    rubric:
      "Create a separate bounded read-only research intent while the unrelated report runs; do not refine that report.",
    segments: [
      oldSegment,
      segment(
        "research-now",
        "Recherchiere unabhängig vom laufenden Wochenbericht die aktuellen Preise von GitHub Actions und GitLab CI für meine Kollegen und vergleiche sie kurz. Nur recherchieren, nichts kaufen oder ändern.",
      ),
    ],
    intents: [report],
    expected: {
      type: "new",
      readOnly: true,
      required: [/github/i, /gitlab/i, /preis|price|kost|cost/i],
      forbidden: [],
    },
  },
  {
    id: "current-alpha-not-negated-beta",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic explicit project negation",
    rubric:
      "Apply only the current Alpha report-heading change, never select the explicitly excluded Beta project.",
    segments: [
      segment(
        "project-now",
        "Vorhin ging es um Projekt Beta. Beta jetzt ausdrücklich nicht anfassen. Im aktuellen Projekt Alpha soll die Überschrift des Berichts jetzt Wochenüberblick heißen.",
      ),
    ],
    intents: [],
    expected: {
      type: "new",
      readOnly: false,
      required: [/wochenüberblick/i, /überschrift|titel|heading/i],
      forbidden: [],
    },
  },
  {
    id: "reuse-completed-result",
    source: "Owner Voice interactivity acceptance, 2026-11-01; synthetic completed team summary",
    rubric:
      "Reference the available completed summary exactly; do not commission or rewrite another report.",
    segments: [
      segment(
        "result-now",
        "Zeig mir bitte noch einmal die fertige Zusammenfassung für meinen Chef. Die liegt ja schon vor; bitte nichts neu erstellen.",
        true,
      ),
    ],
    intents: [
      {
        id: "summary-completed",
        request: "Fasse die drei fiktiven Teamaufgaben für meinen Chef zusammen.",
        provisional: false,
        status: "completed",
        result:
          "Das Team hat drei Aufgaben abgeschlossen: Planung, Umsetzung und gemeinsame Prüfung.",
        sources: [],
      },
    ],
    expected: { type: "reference", intentId: "summary-completed", required: [], forbidden: [] },
  },
  {
    id: "assistant-proposal-contextual-refinement",
    optIn: true,
    source: "Owner Voice cause investigation, 2026-11-02; synthetic report-heading referent",
    rubric:
      "Resolve the heading and new value from the assistant proposal, then refine the existing report only because fresh user speech authorizes that exact change. Never quote the assistant as a user source.",
    conversationContext:
      "assistant: Für den laufenden Wochenbericht schlage ich als neue Überschrift Team-Puls vor. Mit sie meine ich diese Überschrift.",
    segments: [oldSegment, segment("accept-proposal", "Ja, ändere sie genau so.", true)],
    intents: [report],
    expected: {
      type: "refine",
      intentId: report.id,
      readOnly: false,
      required: [/team-puls/i, /überschrift|titel|heading/i],
      forbidden: [/veröffent|publish|deploy|senden|\bsend\b/i],
    },
  },
  {
    id: "assistant-proposal-needs-user-authorization",
    optIn: true,
    source: "Owner Voice cause investigation, 2026-11-02; synthetic assistant-only proposal guard",
    rubric:
      "The assistant proposal is reference data. Acknowledging that it was understood does not authorize changing the existing report or publishing it.",
    conversationContext:
      "assistant: Ich schlage vor, die Überschrift des Wochenberichts auf Team-Puls zu ändern und den Bericht anschließend zu veröffentlichen.",
    segments: [oldSegment, segment("understood-proposal", "Danke, verstanden.", true)],
    intents: [report],
    expected: { type: "conversation", required: [], forbidden: [] },
  },
  {
    id: "rejected-chart-keeps-current-constraint",
    optIn: true,
    source: "Real Voice-call rejection, 2026-11-01; synthetic chart request",
    rubric:
      "The previous proposal never executed. Admit the still-authorized chart once, including the no-files constraint, rather than referencing nonexistent work.",
    segments: [
      segment("chart-request", chartRequest, true),
      segment("chart-constraint", "Ändere keine Dateien.", true),
    ],
    intents: [],
    rejections: [rejectedChart],
    expected: {
      type: "new",
      readOnly: false,
      required: [
        /balken|bar\s*chart/i,
        /montag|monday/i,
        /keine? datei|ohne.*datei|no files|without.*files|do not (modify|change|write).*files/i,
      ],
      forbidden: [/veröffent|publish|deploy|senden|\bsend\b/i],
    },
  },
  {
    id: "rejected-chart-stays-cancelled",
    optIn: true,
    source: "Real Voice-call rejection guard, 2026-11-01; synthetic withdrawal",
    rubric:
      "Do not revive rejected work after an explicit withdrawal. A rejection is not new authorization.",
    segments: [
      segment("chart-request", chartRequest, true),
      segment("chart-withdrawal", "Vergiss das Diagramm. Erstelle es doch nicht.", true),
    ],
    intents: [],
    rejections: [rejectedChart],
    expected: { type: "conversation", required: [], forbidden: [] },
  },
];

export function caseForSample(testCase: IntakeCase, sampleId: string): IntakeCase {
  const segmentId = (id: string) => `${sampleId}:segment:${id}`;
  const intentId = (id: string) => `${sampleId}:intent:${id}`;
  return {
    ...testCase,
    segments: testCase.segments.map((segment) => ({ ...segment, id: segmentId(segment.id) })),
    intents: testCase.intents.map((intent) => ({
      ...intent,
      id: intentId(intent.id),
      sources: intent.sources.map((source) => ({
        ...source,
        segmentId: segmentId(source.segmentId),
      })),
    })),
    ...(testCase.rejections === undefined
      ? {}
      : {
          rejections: testCase.rejections.map((rejection) => ({
            ...rejection,
            requestId: `${sampleId}:rejection:${rejection.requestId}`,
            sources: rejection.sources.map((source) => ({
              ...source,
              segmentId: segmentId(source.segmentId),
            })),
          })),
        }),
    expected: {
      ...testCase.expected,
      ...(testCase.expected.intentId ? { intentId: intentId(testCase.expected.intentId) } : {}),
    },
  };
}

export function snapshotFor(
  testCase: IntakeCase,
  leaseId: string,
  version: number,
): VoiceIntakeSnapshot {
  return {
    requestId: `${leaseId}:${version}`,
    leaseId,
    generation: 1,
    version,
    provisionalReadOnlyAvailable: true,
    defaultProjectId: "project-alpha",
    projects: [
      { id: "project-alpha", title: "Alpha" },
      { id: "project-beta", title: "Beta" },
    ],
    segments: testCase.segments,
    intents: testCase.intents,
    ...(testCase.conversationContext === undefined
      ? {}
      : { conversationContext: testCase.conversationContext }),
    ...(testCase.rejections === undefined ? {} : { rejections: testCase.rejections }),
  };
}

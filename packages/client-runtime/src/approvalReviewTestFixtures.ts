import {
  AuthSessionId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
  type ApprovalReviewOriginalOrder,
  type ApprovalReviewOriginalReceipt,
} from "@t3tools/contracts";
import { hashTelemetryId as sha256 } from "@t3tools/shared/telemetryId";

// Models an imaginary qualified human response in unit tests; it cannot register a host order.
export function syntheticOriginalOrder(expiresAt = 60_000): ApprovalReviewOriginalOrder & {
  receipt: Extract<ApprovalReviewOriginalReceipt, { version: 2 }>;
} {
  const fullText =
    "Originalauftrag 🚀\r\nErstelle genau die neue Testdatei.\r\nKeine bestehende Datei ersetzen.";
  const text = "Erstelle genau die neue Testdatei.";
  const startUtf16 = fullText.indexOf(text);
  const threadId = ThreadId.make("synthetic-original-thread");
  const runId = RunId.make("synthetic-vm-run");
  const destinationThreadId = ThreadId.make("synthetic-vm-thread");
  return {
    receipt: {
      version: 2,
      orderId: "synthetic-host-order",
      orderRevision: 1,
      sourceKind: "human",
      testOnly: false,
      sourceEnvironmentId: EnvironmentId.make("synthetic-source-environment"),
      sessionId: AuthSessionId.make("synthetic-source-session"),
      principal: "synthetic-human-principal",
      threadId,
      messageId: MessageId.make("synthetic-original-message"),
      createdAt: 0,
      expiresAt,
      fullText,
      fullTextHash: sha256(fullText),
      originalLink: "host-order:synthetic-host-order",
      forwardRevision: 1,
      assignment: {
        instructionHash: sha256("synthetic immutable forward instruction"),
        orderId: "synthetic-host-order",
        orderRevision: 1,
        commandId: "synthetic-forward-command",
        fullTextHash: sha256(fullText),
        environmentId: EnvironmentId.make("synthetic-vm-environment"),
        threadId: destinationThreadId,
        messageId: MessageId.make("synthetic-vm-message"),
        runId,
        runOrdinal: 1,
        acceptedSequence: 1,
      },
    },
    excerpt: { startUtf16, endUtf16: startUtf16 + text.length, text },
    destination: { threadId: destinationThreadId, runId },
  };
}

import type { ApprovalReviewAuthority } from "@t3tools/contracts";
import {
  reviewBundleHasVerifiedOrderChannel,
  type ReviewBundle,
} from "@t3tools/client-runtime/approvalReview";
import { AgentMessageRow } from "../chat/AgentMessageRow";
import styles from "./approvalReview.module.css";

function capturedTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unavailable" : date.toISOString();
}

export function ReviewOriginalOrder({
  bundle,
  authority,
  integrityChecked,
  compact = false,
}: {
  bundle: ReviewBundle | null;
  authority: ApprovalReviewAuthority | undefined;
  integrityChecked: boolean;
  compact?: boolean;
}) {
  const verified =
    !!bundle && integrityChecked && reviewBundleHasVerifiedOrderChannel(bundle, authority);
  // Origin text comes from the authenticated host authority after exact package binding.
  const original = verified ? authority?.originalOrder : undefined;
  const receipt = original?.receipt;
  const host = receipt?.version === 2 ? receipt : undefined;
  const synthetic = host?.sourceKind === "synthetic" || host?.testOnly;
  const reason = authority?.provenance?.reason ?? "missing-original";
  const sourceMessage =
    !bundle?.originalOrder || !authority?.originalOrder
      ? "No independently captured original order was supplied. Approval is blocked."
      : authority?.provenance?.status === "verified"
        ? "The displayed original must match the verified package before approval is available."
        : `The host order or request channel could not be verified (${reason}). Approval is blocked.`;
  return (
    <section aria-label="Original host order" className="min-w-0 space-y-3">
      <h2>{verified ? "Host order and request channel verified" : "Host order unverified"}</h2>
      {synthetic ? <p role="status">Synthetic channel test · execution disabled</p> : null}
      {!verified ? (
        <p role="status" className={styles["review-muted"]}>
          {sourceMessage}
        </p>
      ) : null}
      {original ? (
        <>
          <AgentMessageRow
            messageId={original.receipt.messageId}
            text={original.receipt.fullText}
            previewText={original.excerpt.text}
            peerThreadId={undefined}
            peerTitle={null}
            attribution="human"
            principalLabel={original.receipt.principal}
            environmentId={original.receipt.sourceEnvironmentId}
            createdAt={capturedTime(host?.createdAt ?? 0)}
            timestamp="Original"
            timestampTitle={`Captured ${capturedTime(host?.createdAt ?? 0)}`}
            streaming={false}
            originLabel={`Host order · ${host?.orderId}`}
          >
            {(exactText) => <pre className={styles["review-raw"]}>{exactText}</pre>}
          </AgentMessageRow>
          {!compact ? (
            <details>
              <summary>Source and revision</summary>
              <dl className={styles["review-identities"]}>
                <dt>Host environment</dt>
                <dd>{original.receipt.sourceEnvironmentId}</dd>
                <dt>Host order record</dt>
                <dd>{original.receipt.messageId}</dd>
                <dt>Order / revision</dt>
                <dd>
                  {host?.orderId} · {host?.orderRevision}
                </dd>
                <dt>Original SHA-256</dt>
                <dd>{original.receipt.fullTextHash}</dd>
                <dt>Exact excerpt · UTF-16 offsets</dt>
                <dd>
                  {original.excerpt.startUtf16}–{original.excerpt.endUtf16}
                </dd>
                <dt>Destination environment / thread</dt>
                <dd>
                  {host?.assignment.environmentId} / {host?.assignment.threadId}
                </dd>
                <dt>VM run / message</dt>
                <dd>
                  {host?.assignment.runId} / {host?.assignment.messageId}
                </dd>
                <dt>Forward revision / accepted event</dt>
                <dd>
                  {host?.forwardRevision} / {host?.assignment.acceptedSequence}
                </dd>
                <dt>Stored original reference</dt>
                <dd>{original.receipt.originalLink}</dd>
              </dl>
            </details>
          ) : null}
        </>
      ) : null}
      {!compact && bundle?.agentRationale !== undefined ? (
        <section aria-label="Agent rationale">
          <h3>Agent rationale</h3>
          <pre className={styles["review-raw"]}>{bundle.agentRationale}</pre>
        </section>
      ) : null}
    </section>
  );
}

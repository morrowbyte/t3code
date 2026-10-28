import { Dialog as Primitive } from "@base-ui/react/dialog";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { use, useEffect, useRef, useState, useLayoutEffect, lazy, Suspense } from "react";
import { ShieldCheckIcon, XIcon } from "lucide-react";
import {
  parseApprovalReviewDetail,
  verifyReviewBundle,
  reviewBundleHasVerifiedOriginalOrder,
  reviewBundleHasVerifiedOrderChannel,
  type ReviewBundle,
  type ReviewBundleVerification,
} from "@t3tools/client-runtime/approvalReview";
import { canRespondToThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { PendingApproval } from "../../session-logic";
import type {
  EnvironmentId,
  PrivilegedCommandAuthority,
  ProviderApprovalDecision,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import { Dialog } from "../ui/dialog";
import { KeyboardLayerContext } from "../ui/keyboardLayer";
import { Button } from "../ui/button";
import { ReviewOriginalOrder } from "./ReviewOriginalOrder";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import styles from "./approvalReview.module.css";

const SourceEditor = lazy(() =>
  import("./ReviewSourceEditor").then((module) => ({ default: module.ReviewSourceEditor })),
);
interface ReviewPosition {
  location: { path: string; line: number; column?: number };
}
const reviewPositions = new Map<string, ReviewPosition>();

export interface ApprovalReviewProps {
  approval: PendingApproval;
  privilegedCommand?: PrivilegedCommandAuthority | undefined;
  targetLabel?: string | undefined;
  environmentId?: EnvironmentId | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRespond?:
    | ((
        id: RuntimeRequestId,
        decision: ProviderApprovalDecision,
        packageHash?: string,
      ) => Promise<unknown>)
    | undefined;
  disabled?: boolean;
}

function ArtifactChanges({ bundle }: { bundle: ReviewBundle }) {
  const appearance = useRenderedAppearance();
  const pairs = bundle.files.flatMap((file) => {
    if (file.presentation?.role !== "original") return [];
    const after = bundle.files.find(
      (entry) =>
        entry.presentation?.artifact === file.presentation?.artifact &&
        entry.presentation?.role === "revised",
    );
    return after
      ? [
          {
            before: file,
            after,
            diff: parseDiffFromFile(
              { name: file.path, contents: file.content },
              { name: after.path, contents: after.content },
            ),
          },
        ]
      : [];
  });
  return (
    <section className={styles["review-scroll"]} aria-label="Artifact changes">
      {pairs.length === 0 ? (
        <p>
          No exact original/revised pair was supplied. All supplied files remain available in
          Source.
        </p>
      ) : (
        pairs.map((pair) => (
          <article key={pair.before.path} className={styles["review-change"]}>
            <h2>{pair.before.presentation?.artifact}</h2>
            <p>
              {pair.before.path} → {pair.after.path}
            </p>
            <FileDiff
              fileDiff={pair.diff}
              options={{
                diffStyle: "unified",
                theme: resolveDiffThemeName(appearance),
                themeType: appearance,
                overflow: "scroll",
              }}
            />
          </article>
        ))
      )}
    </section>
  );
}

function privilegedHash(requestId: RuntimeRequestId, command: PrivilegedCommandAuthority): string {
  const b = command.bundle;
  return hashTelemetryId(
    JSON.stringify({
      cwd: b.cwd,
      environmentId: b.environmentId,
      providerSessionId: b.providerSessionId,
      purpose: b.purpose,
      requestId,
      runId: b.runId,
      script: b.script,
      shell: b.shell,
      threadId: b.threadId,
      timeoutMs: b.timeoutMs,
      version: 1,
    }),
  );
}

function SourceUnavailable({ onFailure }: { onFailure: () => void }) {
  useEffect(() => onFailure(), [onFailure]);
  return <p role="alert">The source viewer could not load. Close and reopen the review.</p>;
}

function ReviewContent(props: ApprovalReviewProps) {
  const keyboardLayer = use(KeyboardLayerContext);
  const [parsed] = useState(() => parseApprovalReviewDetail(props.approval.detail));
  const bundle = parsed.kind === "bundle" ? parsed.bundle : null;
  const authority = props.approval.approvalReview;
  const privileged = props.privilegedCommand;
  const commandPath = privileged?.bundle.shell === "powershell" ? "script.ps1" : "script.sh";
  const positionKey = `${props.environmentId}:${props.approval.requestId}:${privileged?.packageHash ?? bundle?.hash ?? "request"}`;
  const [saved] = useState(() => reviewPositions.get(positionKey));
  const [location, setLocation] = useState<{ path: string; line: number; column?: number }>(
    saved?.location ?? {
      path: privileged
        ? commandPath
        : (bundle?.steps[0]?.source?.path ?? bundle?.files[0]?.path ?? "request.txt"),
      line: 1,
    },
  );
  useLayoutEffect(() => {
    reviewPositions.delete(positionKey);
    reviewPositions.set(positionKey, { location });
    if (reviewPositions.size > 12) reviewPositions.delete(reviewPositions.keys().next().value!);
  }, [positionKey, location]);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [verification, setVerification] = useState<ReviewBundleVerification | null>(null);
  const decisionExpiresAt = Math.min(
    authority?.expiresAt ?? Infinity,
    authority?.originalOrder?.receipt.expiresAt ?? Infinity,
  );
  const [expired, setExpired] = useState(
    () => Number.isFinite(decisionExpiresAt) && Date.now() >= decisionExpiresAt,
  );
  useEffect(() => {
    if (!Number.isFinite(decisionExpiresAt) || expired) return;
    const timeout = setTimeout(() => setExpired(true), Math.max(0, decisionExpiresAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [decisionExpiresAt, expired]);
  const [busy, setBusy] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const inFlight = useRef(false);
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const [snapshot] = useState(() => ({
    requestId: props.approval.requestId,
    detail: props.approval.detail,
    environmentId: props.environmentId,
    responder: props.onRespond,
    authorityHash: authority?.packageHash,
    privilegedSnapshot: JSON.stringify(privileged),
  }));
  const changed =
    snapshot.requestId !== props.approval.requestId ||
    snapshot.detail !== props.approval.detail ||
    snapshot.environmentId !== props.environmentId ||
    snapshot.responder !== props.onRespond ||
    snapshot.authorityHash !== authority?.packageHash ||
    snapshot.privilegedSnapshot !== JSON.stringify(privileged);
  useEffect(() => {
    let active = true;
    if (bundle)
      void verifyReviewBundle(bundle).then((result) => {
        if (active) setVerification(result);
      });
    return () => {
      active = false;
    };
  }, [bundle]);
  const sourceFiles = privileged
    ? [
        {
          path: commandPath,
          content: privileged.bundle.script,
          language: privileged.bundle.shell === "powershell" ? "powershell" : "shell",
        },
      ]
    : (bundle?.files ?? [
        {
          path: "request.txt",
          content: props.approval.detail || "No details supplied",
          language: "text",
        },
      ]);
  const canApprove =
    !sourceFailed &&
    (privileged
      ? privileged.state === "pending" &&
        !privileged.result &&
        props.approval.responseCapability === "external" &&
        props.environmentId === privileged.bundle.environmentId &&
        privilegedHash(props.approval.requestId, privileged) === privileged.packageHash
      : parsed.kind === "none"
        ? !authority
        : !!bundle &&
          !bundle.exampleOnly &&
          verification?.valid === true &&
          reviewBundleHasVerifiedOriginalOrder(bundle, authority) &&
          !!authority &&
          props.approval.responseCapability === "external" &&
          authority.state === "pending" &&
          !expired &&
          authority.packageHash === bundle.hash &&
          authority.verifiedTargetId === bundle.target.identity);
  const syntheticOrder =
    !!bundle &&
    verification?.valid === true &&
    reviewBundleHasVerifiedOrderChannel(bundle, authority) &&
    authority?.originalOrder?.receipt.version === 2 &&
    (authority.originalOrder.receipt.sourceKind === "synthetic" ||
      authority.originalOrder.receipt.testOnly);
  const respond = async (decision: ProviderApprovalDecision) => {
    const live = current.current;
    if (
      inFlight.current ||
      busy ||
      changed ||
      response ||
      !live.onRespond ||
      live.disabled ||
      (privileged
        ? privileged.state !== "pending" ||
          !!privileged.result ||
          live.approval.responseCapability !== "external" ||
          (decision !== "accept" && decision !== "decline") ||
          live.environmentId !== privileged.bundle.environmentId ||
          privilegedHash(live.approval.requestId, privileged) !== privileged.packageHash
        : !canRespondToThreadApproval(live.approval, decision, authority?.packageHash)) ||
      bundle?.exampleOnly ||
      (decision === "accept" &&
        (!canApprove ||
          (bundle && !reviewBundleHasVerifiedOriginalOrder(bundle, live.approval.approvalReview)) ||
          Date.now() >= decisionExpiresAt))
    )
      return;
    if (
      live.approval.requestId !== snapshot.requestId ||
      live.approval.detail !== snapshot.detail ||
      live.environmentId !== snapshot.environmentId ||
      live.onRespond !== snapshot.responder
    )
      return;
    const options = live.approval.options;
    if (options && !options.some((option) => option.decision === decision)) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = privileged
        ? await live.onRespond(live.approval.requestId, decision, privileged.packageHash)
        : authority
          ? await live.onRespond(live.approval.requestId, decision, authority.packageHash)
          : await live.onRespond(live.approval.requestId, decision);
      if (
        result !== null &&
        typeof result === "object" &&
        "_tag" in result &&
        result._tag === "Failure"
      ) {
        setResponse(
          "Decision rejected by the server. The request has not been approved. Close and reopen it to inspect its current state.",
        );
        return;
      }
      setResponse(
        decision === "accept"
          ? "Approval submitted. Execution and target verification remain unconfirmed."
          : "Rejection submitted. No execution evidence supplied.",
      );
    } catch {
      setResponse("Decision failed. Close and reopen this request to inspect its current state.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const canAct =
    !props.disabled &&
    (props.approval.responseCapability === "live" ||
      props.approval.responseCapability === "external") &&
    !!props.onRespond &&
    !changed &&
    !busy &&
    !response &&
    !bundle?.exampleOnly &&
    (!privileged || (privileged.state === "pending" && !privileged.result && canApprove));
  const permits = (decision: ProviderApprovalDecision) =>
    !props.approval.options ||
    props.approval.options.some((option) => option.decision === decision);
  return (
    <Primitive.Portal>
      <Primitive.Backdrop className={styles["review-backdrop"]} />
      <Primitive.Popup
        className={styles["approval-review"]}
        data-slot="dialog-popup"
        data-keyboard-layer={keyboardLayer ?? undefined}
        data-keyboard-local="true"
        initialFocus={(interaction) =>
          interaction === "touch"
            ? false
            : document.querySelector<HTMLElement>("[data-review-first-focus]")
        }
      >
        <header className={styles["review-header"]}>
          <div className={styles["review-heading"]}>
            <ShieldCheckIcon aria-hidden />
            <div>
              <span className={styles["review-eyebrow"]}>
                {privileged
                  ? `Privileged action · ${privileged.state}`
                  : bundle?.exampleOnly
                    ? "Blocked example · no action submitted"
                    : "Pending approval"}
              </span>
              <Primitive.Title>
                {privileged
                  ? "Review privileged action"
                  : (bundle?.title ?? props.approval.appName ?? "Review agent request")}
              </Primitive.Title>
            </div>
          </div>
          <Primitive.Close
            data-review-first-focus
            data-slot="dialog-close"
            aria-label="Close review"
            render={<Button variant="ghost" size="icon" />}
          >
            <XIcon />
          </Primitive.Close>
        </header>
        <Primitive.Description className="sr-only">
          Review the proposed action, exact source and scope. Opening or closing this view does not
          approve anything.
        </Primitive.Description>
        <div className={styles["review-meta"]}>
          <span>
            <b>Target</b>{" "}
            {privileged
              ? props.targetLabel
                ? `${props.targetLabel} (${privileged.bundle.environmentId})`
                : privileged.bundle.environmentId
              : (bundle?.target.label ?? props.environmentId ?? "Not supplied")}
          </span>
          {privileged ? (
            <>
              <span>
                <b>Rights</b> Elevated
              </span>
              <span>
                <b>Shell</b> {privileged.bundle.shell}
              </span>
              <span>
                <b>Working directory</b> {privileged.bundle.cwd}
              </span>
            </>
          ) : null}
          {bundle?.target.rights?.length && !privileged ? (
            <span>
              <b>Rights</b> {bundle.target.rights.join(" · ")}
            </span>
          ) : null}
        </div>
        {changed ? (
          <div role="alert" className={styles["review-warning"]}>
            The request changed. This review is stale and cannot send a decision. Close and reopen
            it.
          </div>
        ) : null}
        {!privileged && parsed.kind === "invalid" ? (
          <div role="alert" className={styles["review-warning"]}>
            Invalid review package: {parsed.error}. Approval is blocked.
          </div>
        ) : null}
        {!privileged &&
        (authority || bundle) &&
        !canApprove &&
        !bundle?.exampleOnly &&
        !changed &&
        !syntheticOrder ? (
          <div role="status" className={styles["review-warning"]}>
            {!bundle?.originalOrder || authority?.provenance?.status !== "verified"
              ? "Original order unverified. Approval is blocked."
              : "Approval requires this exact verified original, package and current host authority."}
          </div>
        ) : null}
        <main className={styles["review-main"]}>
          {privileged ? (
            <p className={styles["review-purpose"]}>
              <b>Action</b> {privileged.bundle.purpose}
            </p>
          ) : bundle?.steps[0]?.description ? (
            <p className={styles["review-purpose"]}>
              <b>Action</b> {bundle.steps[0].description}
            </p>
          ) : null}
          <div className={styles["review-source"]}>
            <RenderErrorBoundary
              fallback={<SourceUnavailable onFailure={() => setSourceFailed(true)} />}
            >
              <Suspense fallback={<p role="status">Loading source editor…</p>}>
                <SourceEditor
                  compact
                  files={sourceFiles}
                  symbols={bundle?.symbols ?? []}
                  location={location}
                  sessionKey={`${props.environmentId}:${props.approval.requestId}:${privileged?.packageHash ?? bundle?.hash ?? "provider-request"}`}
                  onLocationChange={setLocation}
                />
              </Suspense>
            </RenderErrorBoundary>
          </div>
          {privileged ? (
            <details className={styles["review-details"]}>
              <summary>Details</summary>
              <dl className={styles["review-identities"]}>
                <dt>Package SHA-256</dt>
                <dd>{privileged.packageHash}</dd>
                <dt>Status</dt>
                <dd>{privileged.state}</dd>
                <dt>Result</dt>
                <dd>
                  {privileged.state === "completed"
                    ? (privileged.result?.status ?? "Unconfirmed")
                    : "Unconfirmed"}
                </dd>
              </dl>
              {privileged.result?.stdout ? (
                <pre aria-label="Standard output" className={styles["review-raw"]}>
                  {privileged.result.stdout}
                </pre>
              ) : null}
              {privileged.result?.stderr ? (
                <pre aria-label="Error output" className={styles["review-raw"]}>
                  {privileged.result.stderr}
                </pre>
              ) : null}
            </details>
          ) : (
            <details className={styles["review-details"]}>
              <summary>Details</summary>
              <ReviewOriginalOrder
                bundle={bundle}
                authority={authority}
                integrityChecked={verification?.valid === true}
              />
              {bundle ? <ArtifactChanges bundle={bundle} /> : null}
              <section className={styles["review-scroll"] + " " + styles["review-evidence"]}>
                <h2>Approval and execution evidence</h2>
                <div className={styles["review-evidence-stages"]}>
                  <article>
                    <span>01 · Proposal</span>
                    <h3>{bundle ? "Frozen review package" : "Provider request"}</h3>
                    <p>
                      {bundle
                        ? verification === null
                          ? "Checking exact file and package hashes…"
                          : verification.valid
                            ? "File bytes and package SHA-256 verified locally."
                            : verification.error
                        : "No package identity or hash supplied."}
                    </p>
                  </article>
                  <article>
                    <span>02 · Approval</span>
                    <h3>
                      {bundle?.exampleOnly
                        ? "Example blocked"
                        : response
                          ? "Decision response"
                          : authority && authority.state !== "pending"
                            ? authority.state
                            : "No decision recorded here"}
                    </h3>
                    <p>
                      {response ??
                        (bundle
                          ? authority
                            ? `Host authority: ${authority.state}. ${expired ? "Expired." : "Bound to this package hash and verified target."}`
                            : "No trusted host authority is bound to this package. Approval is blocked."
                          : "Only the existing request-specific authority can respond.")}
                    </p>
                  </article>
                  <article>
                    <span>03 · Execution</span>
                    <h3>
                      {authority?.receipt?.outcome === "reported_succeeded"
                        ? "Worker reported success"
                        : authority?.receipt?.outcome === "reported_failed"
                          ? "Worker reported failure"
                          : authority?.receipt?.outcome === "unknown"
                            ? "Execution unknown"
                            : "Unconfirmed"}
                    </h3>
                    <p>
                      {authority?.receipt
                        ? "A worker report is attached. Independent target verification and complete original outputs must be checked separately."
                        : "No execution receipt, original output or target verification was supplied. A submitted decision is not proof of execution."}
                    </p>
                  </article>
                </div>
                <dl className={styles["review-identities"]}>
                  <dt>Request</dt>
                  <dd>{props.approval.requestId}</dd>
                  <dt>Environment</dt>
                  <dd>{props.environmentId ?? "Not supplied"}</dd>
                  <dt>Package / version</dt>
                  <dd>{bundle ? `${bundle.packageId} / ${bundle.version}` : "Not supplied"}</dd>
                  <dt>SHA-256</dt>
                  <dd>{bundle?.hash ?? "Not supplied"}</dd>
                  <dt>Target identity</dt>
                  <dd>{bundle?.target.identity ?? "Not supplied"}</dd>
                </dl>
                {authority ? (
                  <details>
                    <summary>Host authority and worker report</summary>
                    <pre className={styles["review-raw"]}>{JSON.stringify(authority, null, 2)}</pre>
                  </details>
                ) : null}
                {authority?.receipt?.readback ? (
                  <details>
                    <summary>Target readback reported by worker</summary>
                    <dl className={styles["review-identities"]}>
                      <dt>Target / path</dt>
                      <dd>
                        {authority.receipt.readback.targetIdentity} ·{" "}
                        {authority.receipt.readback.path}
                      </dd>
                      <dt>Content SHA-256</dt>
                      <dd>{authority.receipt.readback.contentHash}</dd>
                      <dt>Mode / owner</dt>
                      <dd>
                        {authority.receipt.readback.mode.toString(8)} · UID{" "}
                        {authority.receipt.readback.uid ?? "not supplied"} · GID{" "}
                        {authority.receipt.readback.gid ?? "not supplied"}
                      </dd>
                    </dl>
                  </details>
                ) : null}
                {bundle?.warnings.length ? (
                  <div className={styles["review-warning"]}>
                    <h3>Limits and risks</h3>
                    <ul>
                      {bundle.warnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {bundle ? (
                  <details>
                    <summary>Exact package files and hashes</summary>
                    <dl className={styles["review-file-hashes"]}>
                      {bundle.files.map((file) => (
                        <div key={file.path}>
                          <dt>{file.path}</dt>
                          <dd>{file.sha256}</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                ) : null}
              </section>
            </details>
          )}
        </main>
        <footer className={styles["review-footer"]}>
          <div role="status">
            {privileged
              ? (response ??
                (changed
                  ? "Request changed · reopen to review"
                  : privileged.state === "pending"
                    ? canApprove
                      ? `Approve once · ${privileged.packageHash.slice(0, 16)}`
                      : "Approval blocked · package or target mismatch"
                    : privileged.state === "claimed" || privileged.state === "unknown"
                      ? "Execution outcome unconfirmed · no new decision available"
                      : `Status: ${privileged.state}${privileged.result ? ` · ${privileged.result.status}` : ""}`))
              : (response ??
                (bundle?.exampleOnly
                  ? "Example only. No approval or execution is possible."
                  : parsed.kind !== "none"
                    ? canApprove
                      ? `Approve once · ${bundle?.hash.slice(0, 16)} · ${authority?.verifiedTargetId}`
                      : expired
                        ? "Approval expired · prepare a fresh request"
                        : syntheticOrder
                          ? "Synthetic test · execution disabled"
                          : "Package approval blocked · trusted binding unavailable or integrity check failed"
                    : props.approval.responseCapability === "not_resumable"
                      ? "Provider disconnected · decisions unavailable"
                      : "Applies only to this pending request. Execution remains unconfirmed."))}
          </div>
          <div className={styles["review-decisions"]}>
            <Button
              variant="outline"
              disabled={!canAct || !permits("decline")}
              onClick={() => void respond("decline")}
            >
              Reject
            </Button>
            <Button
              disabled={!canAct || !canApprove || !permits("accept")}
              onClick={() => void respond("accept")}
            >
              Approve once
            </Button>
          </div>
        </footer>
      </Primitive.Popup>
    </Primitive.Portal>
  );
}

export function ApprovalReview(props: ApprovalReviewProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open ? <ReviewContent {...props} /> : null}
    </Dialog>
  );
}

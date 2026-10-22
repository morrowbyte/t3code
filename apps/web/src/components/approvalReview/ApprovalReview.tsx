import { Dialog as Primitive } from "@base-ui/react/dialog";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { use, useEffect, useRef, useState, useLayoutEffect, lazy, Suspense } from "react";
import { FileCodeIcon, ShieldCheckIcon, XIcon } from "lucide-react";
import {
  parseApprovalReviewDetail,
  verifyReviewBundle,
  type ReviewBundle,
  type ReviewBundleVerification,
} from "@t3tools/client-runtime/approvalReview";
import { canRespondToThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import type { PendingApproval } from "../../session-logic";
import type { EnvironmentId, ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";
import { Dialog } from "../ui/dialog";
import { KeyboardLayerContext } from "../ui/keyboardLayer";
import { Button } from "../ui/button";
import { ReviewActivity } from "./ReviewActivity";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { RenderErrorBoundary } from "../RenderErrorBoundary";
import styles from "./approvalReview.module.css";

const SourceEditor = lazy(() =>
  import("./ReviewSourceEditor").then((module) => ({ default: module.ReviewSourceEditor })),
);
type ReviewTab = "process" | "source" | "changes" | "evidence";
interface ReviewPosition {
  tab: ReviewTab;
  selectedId: string;
  location: { path: string; line: number; column?: number };
}
const reviewPositions = new Map<string, ReviewPosition>();

export interface ApprovalReviewProps {
  approval: PendingApproval;
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

function ReviewContent(props: ApprovalReviewProps) {
  const keyboardLayer = use(KeyboardLayerContext);
  const [parsed] = useState(() => parseApprovalReviewDetail(props.approval.detail));
  const bundle = parsed.kind === "bundle" ? parsed.bundle : null;
  const authority = props.approval.approvalReview;
  const positionKey = `${props.environmentId}:${props.approval.requestId}:${bundle?.hash ?? "request"}`;
  const [saved] = useState(() => reviewPositions.get(positionKey));
  const [tab, setTab] = useState<ReviewTab>(saved?.tab ?? "process");
  const [selectedId, setSelectedId] = useState(
    saved?.selectedId ?? bundle?.steps[0]?.id ?? "request",
  );
  const [location, setLocation] = useState<{ path: string; line: number; column?: number }>(
    saved?.location ??
      bundle?.steps[0]?.source ?? { path: bundle?.files[0]?.path ?? "request.txt", line: 1 },
  );
  useLayoutEffect(() => {
    reviewPositions.delete(positionKey);
    reviewPositions.set(positionKey, { tab, selectedId, location });
    if (reviewPositions.size > 12) reviewPositions.delete(reviewPositions.keys().next().value!);
  }, [positionKey, tab, selectedId, location]);
  const [verification, setVerification] = useState<ReviewBundleVerification | null>(null);
  const [expired, setExpired] = useState(
    () => authority !== undefined && Date.now() >= authority.expiresAt,
  );
  useEffect(() => {
    if (!authority || expired) return;
    const timeout = setTimeout(
      () => setExpired(true),
      Math.max(0, authority.expiresAt - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [authority, expired]);
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
  }));
  const changed =
    snapshot.requestId !== props.approval.requestId ||
    snapshot.detail !== props.approval.detail ||
    snapshot.environmentId !== props.environmentId ||
    snapshot.responder !== props.onRespond ||
    snapshot.authorityHash !== authority?.packageHash;
  const selected = bundle?.steps.find((step) => step.id === selectedId) ?? bundle?.steps[0];
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
  const sourceFiles = bundle?.files ?? [
    {
      path: "request.txt",
      content: props.approval.detail || "No details supplied",
      language: "text",
    },
  ];
  const select = (id: string) => {
    setSelectedId(id);
    const source = bundle?.steps.find((step) => step.id === id)?.source;
    if (source) setLocation(source);
  };
  const source = () => {
    if (selected?.source) setLocation(selected.source);
    setTab("source");
  };
  const canApprove =
    parsed.kind === "none"
      ? !authority
      : !!bundle &&
        !bundle.exampleOnly &&
        verification?.valid === true &&
        !!authority &&
        props.approval.responseCapability === "external" &&
        authority.state === "pending" &&
        !expired &&
        authority.packageHash === bundle.hash &&
        authority.verifiedTargetId === bundle.target.identity;
  const respond = async (decision: ProviderApprovalDecision) => {
    const live = current.current;
    if (
      inFlight.current ||
      busy ||
      changed ||
      response ||
      !live.onRespond ||
      live.disabled ||
      !canRespondToThreadApproval(live.approval, decision, authority?.packageHash) ||
      bundle?.exampleOnly ||
      (decision === "accept" && (!canApprove || (authority && Date.now() >= authority.expiresAt)))
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
      const result = authority
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
    !bundle?.exampleOnly;
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
                {bundle?.exampleOnly ? "Blocked example · no action submitted" : "Pending approval"}
              </span>
              <Primitive.Title>
                {bundle?.title ?? props.approval.appName ?? "Review agent request"}
              </Primitive.Title>
            </div>
          </div>
          <Primitive.Close
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
            <b>Target</b> {bundle?.target.label ?? props.environmentId ?? "Not supplied"}
          </span>
          <span>
            <b>Rights</b> {bundle?.target.rights?.join(" · ") || "Not supplied"}
          </span>
          <span className={styles["review-proposal-label"]}>Proposal · not executed</span>
        </div>
        <nav className={styles["review-tabs"]} aria-label="Review views">
          {(
            [
              ["process", "Process"],
              ["source", "Source"],
              ["changes", "Changes"],
              ["evidence", "Evidence"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              data-review-first-focus={value === "process" ? true : undefined}
              type="button"
              aria-current={tab === value ? "page" : undefined}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        {changed ? (
          <div role="alert" className={styles["review-warning"]}>
            The request changed. This review is stale and cannot send a decision. Close and reopen
            it.
          </div>
        ) : null}
        {parsed.kind === "invalid" ? (
          <div role="alert" className={styles["review-warning"]}>
            Invalid review package: {parsed.error}. Approval is blocked.
          </div>
        ) : null}
        <main className={styles["review-main"]}>
          <div className={styles["review-process"]} hidden={tab !== "process"}>
            {bundle && bundle.steps.length ? (
              <>
                <ReviewActivity
                  bundle={bundle}
                  selectedId={selectedId}
                  onSelect={select}
                  onSource={source}
                  active={tab === "process"}
                  sessionKey={positionKey}
                />
                <aside className={styles["review-inspector"]}>
                  <span className={styles["review-eyebrow"]}>
                    Selected step · {bundle.steps.findIndex((step) => step.id === selected?.id) + 1}{" "}
                    / {bundle.steps.length}
                  </span>
                  <h2>{selected?.title}</h2>
                  <p>{selected?.description}</p>
                  {selected?.effects?.length ? (
                    <>
                      <h3>Proposed effects</h3>
                      <ul>
                        {selected.effects.map((effect) => (
                          <li key={effect}>{effect}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {selected?.source ? (
                    <Button variant="outline" onClick={source}>
                      <FileCodeIcon />
                      {selected.source.path}:{selected.source.line}
                    </Button>
                  ) : (
                    <p className={styles["review-muted"]}>
                      No source location supplied for this node.
                    </p>
                  )}
                  <h3>Control flow</h3>
                  <ul>
                    {bundle.edges
                      .filter((edge) => edge.from === selected?.id)
                      .map((edge) => (
                        <li key={`${edge.from}:${edge.to}:${edge.label ?? ""}`}>
                          <button type="button" onClick={() => select(edge.to)}>
                            {edge.label ? `${edge.label} → ` : "Next → "}
                            {bundle.steps.find((step) => step.id === edge.to)?.title}
                          </button>
                        </li>
                      ))}
                  </ul>
                  <details className={styles["review-step-list"]}>
                    <summary>All steps</summary>
                    <ol>
                      {bundle.steps.map((step) => (
                        <li key={step.id}>
                          <button
                            type="button"
                            aria-current={step.id === selectedId ? "step" : undefined}
                            onClick={() => select(step.id)}
                          >
                            {step.title}
                          </button>
                        </li>
                      ))}
                    </ol>
                  </details>
                </aside>
              </>
            ) : (
              <section className={styles["review-scroll"]}>
                <span className={styles["review-eyebrow"]}>Provider request</span>
                <h2>{props.approval.appName ?? props.approval.requestKind}</h2>
                <p>No structured activity diagram or frozen bundle was supplied.</p>
                <pre className={styles["review-raw"]}>
                  {props.approval.detail || "No details supplied"}
                </pre>
                <Button variant="outline" onClick={() => setTab("source")}>
                  Open complete request
                </Button>
              </section>
            )}
          </div>
          <div className={styles["review-source"]} hidden={tab !== "source"}>
            <RenderErrorBoundary
              fallback={
                <p role="alert">
                  The source viewer could not load. Close and reopen the review after checking the
                  connection. Approval remains blocked for structured packages.
                </p>
              }
            >
              <Suspense fallback={<p role="status">Loading source editor…</p>}>
                <SourceEditor
                  active={tab === "source"}
                  files={sourceFiles}
                  symbols={bundle?.symbols ?? []}
                  location={location}
                  sessionKey={`${props.environmentId}:${props.approval.requestId}:${bundle?.hash ?? "provider-request"}`}
                  onLocationChange={(next) => {
                    setLocation(next);
                    const step = bundle?.steps
                      .filter(
                        (entry) =>
                          entry.source?.path === next.path &&
                          entry.source.line <= next.line &&
                          (entry.source.endLine ?? entry.source.line) >= next.line,
                      )
                      .sort((a, b) => (b.source?.line ?? 0) - (a.source?.line ?? 0))[0];
                    if (step) setSelectedId(step.id);
                  }}
                />
              </Suspense>
            </RenderErrorBoundary>
          </div>
          {tab === "changes" ? (
            bundle ? (
              <ArtifactChanges bundle={bundle} />
            ) : (
              <section className={styles["review-scroll"]}>
                <h2>No artifact pair supplied</h2>
                <p>Source shows the exact provider request.</p>
              </section>
            )
          ) : null}
          {tab === "evidence" ? (
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
          ) : null}
        </main>
        <footer className={styles["review-footer"]}>
          <div role="status">
            {response ??
              (bundle?.exampleOnly
                ? "Example only. No approval or execution is possible."
                : parsed.kind !== "none"
                  ? canApprove
                    ? `Approve once · ${bundle?.hash.slice(0, 16)} · ${authority?.verifiedTargetId}`
                    : expired
                      ? "Approval expired · prepare a fresh request"
                      : "Package approval blocked · trusted binding unavailable or integrity check failed"
                  : props.approval.responseCapability === "not_resumable"
                    ? "Provider disconnected · decisions unavailable"
                    : "Applies only to this pending request. Execution remains unconfirmed.")}
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

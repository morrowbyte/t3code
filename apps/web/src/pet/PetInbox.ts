import {
  type DesktopPetItemKind,
  type DesktopPetProjection,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { petSummary } from "./PetSummary";

export function petPendingRequests(
  pending: PendingThreadRequests | null,
  summary: Pick<OrchestrationV2PendingRuntimeRequestSummary, "id" | "kind"> | null,
  turnItems: readonly { id: string; type: string; status: string }[],
) {
  const requests: { id: string; kind: "approval" | "question"; publicText?: string }[] = [];
  for (const approval of pending?.approvals ?? [])
    if (approval.responseCapability !== "not_resumable")
      requests.push({ id: approval.requestId, kind: "approval" });
  for (const question of pending?.userInputs ?? [])
    if (question.responseCapability !== "not_resumable")
      requests.push({
        id: question.requestId,
        kind: "question",
        publicText: question.questions.map((item) => item.question).join(" "),
      });
  if (
    summary &&
    !requests.some((request) => request.id === summary.id) &&
    turnItems.some(
      (item) =>
        item.id === summary.id &&
        item.status === "waiting" &&
        (item.type === "secret_request" || item.type === "link_request"),
    )
  )
    requests.push({ id: summary.id, kind: "question" });
  return requests;
}

export interface PetCandidate {
  readonly key: string;
  readonly kind: DesktopPetItemKind;
  readonly ref: ScopedThreadRef;
  readonly threadNumber: number;
  readonly publicText?: string | undefined;
}
const priority = { approval: 0, question: 1, result: 2 };

export class PetInbox {
  private entries = new Map<string, { candidate: PetCandidate; id: string }>();
  private dismissed = new Set<string>();
  private revision = 0;
  private signature = "";
  private visible = new Map<string, PetCandidate>();

  private readonly token: () => string;
  constructor(token: () => string) {
    this.token = token;
  }

  update(
    candidates: readonly PetCandidate[],
    workingCount: number,
    disconnectedEnvironments: ReadonlySet<string> = new Set(),
  ): DesktopPetProjection | null {
    const next = new Map<string, { candidate: PetCandidate; id: string }>();
    for (const candidate of candidates) {
      if (!next.has(candidate.key))
        next.set(candidate.key, {
          candidate,
          id: this.entries.get(candidate.key)?.id ?? this.token(),
        });
    }
    const offline = [...this.entries]
      .filter(([, entry]) => disconnectedEnvironments.has(entry.candidate.ref.environmentId))
      .slice(-200);
    this.entries = new Map([...offline, ...next]);
    this.dismissed = new Set([...this.dismissed].filter((key) => this.entries.has(key)));
    const selected = [...next.values()]
      .filter(({ candidate }) => !this.dismissed.has(candidate.key))
      .sort((a, b) => priority[a.candidate.kind] - priority[b.candidate.kind])
      .slice(0, 20);
    this.visible = new Map(selected.map(({ id, candidate }) => [id, candidate]));
    const items = selected.map(({ id, candidate }) => ({
      id,
      kind: candidate.kind,
      summary: petSummary(candidate.kind, candidate.threadNumber, candidate.publicText),
    }));
    const signature = JSON.stringify({ workingCount, items });
    if (signature === this.signature) return null;
    this.signature = signature;
    return { v: 1, type: "projection", revision: ++this.revision, workingCount, items };
  }

  resolve(id: string) {
    return this.visible.get(id);
  }
  dismiss(id: string) {
    const candidate = this.resolve(id);
    if (candidate) this.dismissed.add(candidate.key);
  }
}

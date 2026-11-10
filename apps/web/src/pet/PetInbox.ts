import {
  DESKTOP_PET_SUMMARIES,
  type DesktopPetItemKind,
  type DesktopPetProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";

export interface PetCandidate {
  readonly key: string;
  readonly kind: DesktopPetItemKind;
  readonly ref: ScopedThreadRef;
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
      summary: DESKTOP_PET_SUMMARIES[candidate.kind],
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

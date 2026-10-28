import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewAnnotationPayload, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface PreviewSelectionState {
  readonly byThreadKey: Record<string, PreviewAnnotationPayload>;
  readonly replaceSelection: (ref: ScopedThreadRef, annotation: PreviewAnnotationPayload) => void;
  /** An expected id keeps a completed send from clearing a newer selection. */
  readonly clearSelection: (ref: ScopedThreadRef, expectedId?: string) => void;
}

/** Ephemeral context for feedback and Voice; selecting never modifies the composer draft. */
export const usePreviewSelectionStore = create<PreviewSelectionState>()((set) => ({
  byThreadKey: {},
  replaceSelection: (ref, annotation) =>
    set((state) => ({
      byThreadKey: { ...state.byThreadKey, [scopedThreadKey(ref)]: annotation },
    })),
  clearSelection: (ref, expectedId) =>
    set((state) => {
      const key = scopedThreadKey(ref);
      const current = state.byThreadKey[key];
      if (!current || (expectedId !== undefined && current.id !== expectedId)) return state;
      const { [key]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function useThreadPreviewSelection(
  ref: ScopedThreadRef | null,
): PreviewAnnotationPayload | null {
  return usePreviewSelectionStore((state) =>
    ref ? (state.byThreadKey[scopedThreadKey(ref)] ?? null) : null,
  );
}

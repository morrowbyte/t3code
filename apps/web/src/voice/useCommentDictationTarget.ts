import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";

export function useCommentDictationTarget() {
  const target = useThreadRouteTarget();
  const draftEnvironmentId = useComposerDraftStore((store) =>
    target?.kind === "draft"
      ? (store.draftThreadsByThreadKey[target.draftId]?.environmentId ?? null)
      : null,
  );
  return {
    environmentId: target?.kind === "server" ? target.threadRef.environmentId : draftEnvironmentId,
    targetKey: JSON.stringify(target),
  };
}

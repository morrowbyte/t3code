import type { ScopedThreadRef } from "@t3tools/contracts";
import { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";
import { useQuietThreadShell } from "~/state/entities";
import { useAgentAvatar, useAgentAvatarActions } from "~/state/agentAvatars";
import { Button } from "~/components/ui/button";
import { ThreadDetailsSection } from "~/components/chat/ThreadDetailsSection";
import { AgentIdentityLabel } from "./AgentIdentityLabel";
import { useAgentIdentityTheme } from "./useAgentIdentityTheme";

export function AgentAvatarSettings({ threadRef }: { threadRef: ScopedThreadRef }) {
  const [theme] = useAgentIdentityTheme();
  const thread = useQuietThreadShell(threadRef);
  const identity = deriveAgentIdentity(threadRef, thread?.lineage, theme);
  const avatar = useAgentAvatar(threadRef, theme);
  const actions = useAgentAvatarActions(threadRef, theme);
  const generating = avatar.data?.status === "generating";
  const error = actions.error ?? avatar.error ?? avatar.data?.error;
  const hasImage = Boolean(avatar.data?.attachmentId);

  return (
    <ThreadDetailsSection headingId="thread-details-avatar-heading" title="Agentenbild">
      <div className="space-y-2 px-3 pb-2 text-xs">
        <AgentIdentityLabel threadRef={threadRef} />
        <div className="text-muted-foreground">ChatGPT-Subscription</div>
        <div role="status" aria-live="polite">
          {generating
            ? "Wird erzeugt…"
            : actions.pending
              ? "Anfrage läuft…"
              : avatar.isPending && !avatar.data
                ? "Wird geladen…"
                : avatar.data?.status === "failed"
                  ? "Fehlgeschlagen"
                  : avatar.data?.status === "cancelled"
                    ? "Abgebrochen"
                    : avatar.data?.status === "ready"
                      ? "Bereit"
                      : null}
        </div>
        {error ? (
          <p role="alert" className="break-words text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {generating ? (
            <Button
              variant="outline"
              size="sm"
              disabled={!actions.canCancel || actions.pending}
              onClick={() => void actions.cancel()}
            >
              Abbrechen
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={
                !actions.canGenerate || actions.pending || !avatar.data || Boolean(avatar.error)
              }
              onClick={() => void actions.generate(identity.name, hasImage)}
            >
              {avatar.data?.status === "failed"
                ? "Erneut versuchen"
                : hasImage
                  ? "Neu erzeugen"
                  : "Avatar erzeugen"}
            </Button>
          )}
          {avatar.error ? (
            <Button variant="ghost" size="sm" onClick={avatar.refresh}>
              Erneut laden
            </Button>
          ) : null}
        </div>
      </div>
    </ThreadDetailsSection>
  );
}

import type { VoiceConversationItem } from "@t3tools/client-runtime/live-voice";
import { MicIcon, PhoneIcon } from "lucide-react";
import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { cn } from "~/lib/utils";
import { AgentIdentityLabel } from "~/components/agent-identity/AgentIdentityLabel";

export function VoiceConversationRow({ item }: { readonly item: VoiceConversationItem }) {
  if (item.kind === "notice")
    return (
      <p role="status" className="py-2 text-xs text-muted-foreground">
        {item.text}
      </p>
    );
  if (item.kind !== "speech") {
    const label =
      item.kind === "call-start"
        ? "Voice call"
        : item.call.status === "failed"
          ? "Call failed"
          : item.call.status === "unknown"
            ? "Call interrupted"
            : "Call ended";
    return (
      <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
        <PhoneIcon className="size-3 shrink-0" />
        <span>{label}</span>
        {item.kind === "call-start" && !item.call.endedAt && (
          <span>
            {item.call.status === "active"
              ? "Live"
              : item.call.status === "stopping"
                ? "Ending…"
                : item.call.status === "unknown"
                  ? "Interrupted"
                  : "Connecting…"}
          </span>
        )}
        <time dateTime={item.createdAt} className="tabular-nums">
          {new Date(item.createdAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
    );
  }
  const entry = item.entry;
  const user = entry.speaker === "user";
  const bubble = item.bubble;
  return (
    <article
      aria-label={user ? "You · Voice" : "Live · Voice"}
      className={cn("group/voice relative flex min-w-0 flex-col gap-1", user && "items-end")}
    >
      <div className="flex min-h-6 flex-wrap items-center gap-2 pr-8 text-xs text-muted-foreground">
        <span className="font-medium">
          {!user && bubble ? (
            <AgentIdentityLabel threadRef={bubble} avatarSize={24} />
          ) : user ? (
            "You"
          ) : (
            "Live"
          )}
        </span>
        <span className="inline-flex items-center gap-1">
          <MicIcon className="size-3" />
          {!user && bubble ? "GPT Live" : "Voice"}
        </span>
        <time dateTime={entry.occurredAt} className="tabular-nums">
          {new Date(entry.occurredAt).toLocaleTimeString(undefined, {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
        {!entry.final && (
          <span aria-label={bubble?.settled ? "Partial transcript" : "Transcribing"}>
            {bubble?.settled ? "Partial" : "…"}
          </span>
        )}
      </div>
      <div
        className={cn(
          "min-w-0 max-w-full",
          user && "rounded-2xl rounded-br-sm bg-muted px-4 py-2 sm:max-w-[85%]",
          !user &&
            bubble &&
            "rounded-2xl rounded-bl-sm border border-border bg-muted/40 px-4 py-2 sm:max-w-[85%]",
        )}
      >
        <p className="select-text whitespace-pre-wrap text-sm leading-relaxed wrap-anywhere">
          {entry.text}
        </p>
      </div>
      <div className="absolute top-0 right-0 flex sm:opacity-0 sm:group-hover/voice:opacity-100 sm:group-focus-within/voice:opacity-100">
        <MessageCopyButton text={entry.text} />
      </div>
    </article>
  );
}

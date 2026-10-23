import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { HostOrderComposer } from "./HostOrderComposer";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function HostOrderChatMode({
  destination,
  hosts,
  children,
}: {
  destination: ScopedThreadRef | null;
  hosts: readonly { environmentId: EnvironmentId; label: string }[];
  children: ReactNode;
}) {
  const [hostMode, setHostMode] = useState(false);
  const [opened, setOpened] = useState(false);
  const [selectedHost, setSelectedHost] = useState<EnvironmentId | null>(null);
  const [openedHosts, setOpenedHosts] = useState<readonly EnvironmentId[]>([]);
  const host = hosts.find(
    (entry) =>
      entry.environmentId === selectedHost && entry.environmentId !== destination?.environmentId,
  );
  const chatButton = useRef<HTMLButtonElement>(null);
  const hostPanel = useRef<HTMLElement>(null);
  return (
    <>
      <div
        role="group"
        aria-label="Task delivery"
        className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) flex-wrap gap-2"
      >
        <Button
          ref={chatButton}
          type="button"
          variant={hostMode ? "outline" : "secondary"}
          size="sm"
          aria-pressed={!hostMode}
          onClick={() => setHostMode(false)}
        >
          Agent chat
        </Button>
        <Button
          type="button"
          variant={hostMode ? "secondary" : "outline"}
          size="sm"
          aria-pressed={hostMode}
          disabled={destination === null}
          title={
            destination === null ? "Select the VM thread that will execute the task" : undefined
          }
          onClick={() => {
            setOpened(true);
            setHostMode(true);
            requestAnimationFrame(() => hostPanel.current?.querySelector("textarea")?.focus());
          }}
        >
          Host-bound task
        </Button>
      </div>
      <div hidden={hostMode} inert={hostMode || undefined}>
        {children}
      </div>
      {opened && destination !== null ? (
        <section
          ref={hostPanel}
          hidden={!hostMode}
          inert={!hostMode || undefined}
          aria-label="Host-bound task"
          data-keyboard-local="host-order"
          className="mx-auto max-h-[70dvh] w-full min-w-0 max-w-(--chat-content-max-width) overflow-y-auto rounded-xl border border-border p-4"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setHostMode(false);
            chatButton.current?.focus();
          }}
        >
          <div className="mb-3 space-y-2">
            <Select
              value={host?.environmentId ?? null}
              onValueChange={(value) => {
                const next =
                  hosts.find((entry) => entry.environmentId === value)?.environmentId ?? null;
                setSelectedHost(next);
                if (next)
                  setOpenedHosts((previous) =>
                    previous.includes(next) ? previous : [...previous, next],
                  );
              }}
            >
              <SelectTrigger aria-label="Protecting host">
                <SelectValue placeholder="Choose protecting host">{host?.label}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {hosts
                  .filter((entry) => entry.environmentId !== destination.environmentId)
                  .map((entry) => (
                    <SelectItem key={entry.environmentId} value={entry.environmentId}>
                      {entry.label}
                    </SelectItem>
                  ))}
              </SelectPopup>
            </Select>
            <p className="break-words text-sm text-muted-foreground">
              Execution: {destination.environmentId} / {destination.threadId}
            </p>
          </div>
          {!host ? (
            <p role="status">
              Choose the host that records and protects this task. It must authorize this exact VM
              thread.
            </p>
          ) : null}
          {openedHosts.map((environmentId) => (
            <div
              key={environmentId}
              hidden={environmentId !== host?.environmentId}
              inert={environmentId !== host?.environmentId || undefined}
            >
              <HostOrderComposer environmentId={environmentId} destination={destination} />
            </div>
          ))}
        </section>
      ) : null}
    </>
  );
}

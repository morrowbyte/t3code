import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ShieldIcon, XIcon } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { HostOrderComposer } from "./HostOrderComposer";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useHostOrderComposerStore } from "./HostOrderComposerStore";
import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";

export function ConfiguredHostOrderChatMode(
  props: Omit<Parameters<typeof HostOrderChatMode>[0], "enabled">,
) {
  const enabled = useClientSettings((settings) => settings.hostOrderEntryEnabled);
  const hydrated = useClientSettingsHydrated();
  return <HostOrderChatMode {...props} enabled={hydrated && enabled === true} />;
}

export function HostOrderChatMode({
  enabled = false,
  destination,
  destinationLabel = "Current conversation",
  hosts,
  children,
}: {
  enabled?: boolean;
  destination: ScopedThreadRef | null;
  destinationLabel?: string;
  hosts: readonly { environmentId: EnvironmentId; label: string; connected?: boolean }[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const destinationKey = JSON.stringify(destination);
  const savedHost = useHostOrderComposerStore((state) => state.selectedHosts[destinationKey]);
  const selectedHost =
    hosts.find((entry) => entry.environmentId === savedHost)?.environmentId ?? null;
  const [openedHosts, setOpenedHosts] = useState<readonly EnvironmentId[]>(
    selectedHost ? [selectedHost] : [],
  );
  const host = hosts.find(
    (entry) =>
      entry.environmentId === selectedHost && entry.environmentId !== destination?.environmentId,
  );
  const availableHosts = hosts.filter(
    (entry) => entry.environmentId !== destination?.environmentId,
  );
  const entryButton = useRef<HTMLButtonElement>(null);
  const hostPanel = useRef<HTMLElement>(null);
  const panelId = useId();

  // Keep mounted sessions and their uncertain requests, but never reopen on opt-in alone.
  if (!enabled && open) setOpen(false);

  function closePanel() {
    setOpen(false);
    entryButton.current?.focus();
  }

  return (
    <>
      {enabled ? (
        <div className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) justify-end">
          <Button
            ref={entryButton}
            type="button"
            variant="ghost-muted"
            size="sm"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              setOpened(true);
              setOpen(!open);
              if (!open)
                requestAnimationFrame(() =>
                  (
                    hostPanel.current?.querySelector<HTMLElement>("[role=combobox], textarea") ??
                    hostPanel.current
                  )?.focus(),
                );
            }}
          >
            <ShieldIcon />
            Protected task
          </Button>
        </div>
      ) : null}
      {opened ? (
        <section
          id={panelId}
          ref={hostPanel}
          tabIndex={-1}
          hidden={!open || !enabled}
          inert={!open || !enabled || undefined}
          aria-label="Protected task"
          data-keyboard-local="host-order"
          className="mx-auto mb-3 max-h-[60dvh] w-full min-w-0 max-w-(--chat-content-max-width) overflow-y-auto rounded-xl border border-border bg-background p-4"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            closePanel();
          }}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Protected task</h2>
            <div className="flex items-center gap-2">
              <Link
                to="/settings/integrations"
                hash="protected-tasks"
                className="text-sm underline underline-offset-4"
              >
                Setup
              </Link>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close protected task"
                onClick={closePanel}
              >
                <XIcon />
              </Button>
            </div>
          </div>
          {destination === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Start a conversation before choosing its protecting host.
            </p>
          ) : (
            <>
              <div className="mb-3 space-y-2">
                <p className="break-words text-sm text-muted-foreground">
                  Execution: {destinationLabel}
                </p>
                {availableHosts.length > 0 ? (
                  <Select
                    value={host?.environmentId ?? null}
                    onValueChange={(value) => {
                      const next =
                        availableHosts.find((entry) => entry.environmentId === value)
                          ?.environmentId ?? null;
                      if (next)
                        useHostOrderComposerStore.getState().selectHost(destinationKey, next);
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
                      {availableHosts.map((entry) => (
                        <SelectItem key={entry.environmentId} value={entry.environmentId}>
                          {entry.label}
                          {entry.connected === false ? " · offline" : ""}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    No protecting host is connected. Configure one in Settings.
                  </p>
                )}
              </div>
              {openedHosts.map((environmentId) => {
                const selected = environmentId === host?.environmentId;
                return (
                  <div key={environmentId} hidden={!selected} inert={!selected || undefined}>
                    <HostOrderComposer
                      environmentId={environmentId}
                      destination={destination}
                      hostLabel={
                        hosts.find((entry) => entry.environmentId === environmentId)?.label ??
                        "Protecting host"
                      }
                      active={enabled && open && selected && host?.connected !== false}
                      connected={
                        hosts.find((entry) => entry.environmentId === environmentId)?.connected !==
                        false
                      }
                    />
                  </div>
                );
              })}
            </>
          )}
        </section>
      ) : null}
      {children}
    </>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { InboxIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AttentionInboxView } from "./AttentionInboxView";
import { deriveAttentionInbox } from "./attentionInbox.logic";

function EnvironmentAttention({
  environmentId,
  environmentLabel,
  onClose,
}: {
  environmentId: EnvironmentId;
  environmentLabel: string;
  onClose: () => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot = Option.getOrNull(shell.snapshot);
  const model = deriveAttentionInbox(environmentId, snapshot?.threads ?? []);
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const openThread = (ref: ScopedThreadRef) => {
    setNavigationError(null);
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) })
      .then(() => {
        onClose();
        if (isMobile) setOpenMobile(false);
      })
      .catch(() => setNavigationError("Could not open the source conversation. Try again."));
  };
  return (
    <AttentionInboxView
      model={model}
      environmentLabel={environmentLabel}
      status={shell.status}
      hasSnapshot={snapshot !== null}
      synchronizationError={Option.getOrNull(shell.error)}
      navigationError={navigationError}
      onOpenThread={openThread}
    />
  );
}

function AttentionInboxContent({ onClose }: { onClose: () => void }) {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const route = useParams({ strict: false });
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(
    () =>
      environments.find((environment) => environment.environmentId === route.environmentId)
        ?.environmentId ??
      primaryEnvironmentId ??
      environments[0]?.environmentId ??
      null,
  );
  const selected = environments.find((environment) => environment.environmentId === selectedId);
  return (
    <DialogPopup className="sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Attention inbox</DialogTitle>
        <DialogDescription className="sr-only">
          Questions, approvals, completed work and warnings.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {environments.length > 0 ? (
          <div className="mb-4">
            <Select
              value={selectedId}
              onValueChange={(value) => {
                const environment = environments.find((entry) => entry.environmentId === value);
                if (environment) setSelectedId(environment.environmentId);
              }}
            >
              <SelectTrigger aria-label="Selected environment">
                <SelectValue>{selected?.label ?? "Choose an environment"}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((environment) => (
                  <SelectItem key={environment.environmentId} value={environment.environmentId}>
                    {environment.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        {selected ? (
          <EnvironmentAttention
            key={selected.environmentId}
            environmentId={selected.environmentId}
            environmentLabel={selected.label}
            onClose={onClose}
          />
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {!isReady
              ? "Loading configured environments…"
              : environments.length === 0
                ? "No configured environment is available."
                : "Choose an available environment to load its attention items."}
          </p>
        )}
      </DialogPanel>
    </DialogPopup>
  );
}

export function AttentionInbox() {
  const [open, setOpen] = useState(false);
  return (
    <SidebarMenuItem className="shrink-0">
      <Dialog open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DialogTrigger
                render={<SidebarMenuButton aria-label="Attention inbox" size="icon" />}
              >
                <InboxIcon />
              </DialogTrigger>
            }
          />
          <TooltipPopup side="top">Attention inbox</TooltipPopup>
        </Tooltip>
        {open ? <AttentionInboxContent onClose={() => setOpen(false)} /> : null}
      </Dialog>
    </SidebarMenuItem>
  );
}

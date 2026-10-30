import { useNavigate, useParams } from "@tanstack/react-router";
import type { PinnedWorkTab, ClientSettings } from "@t3tools/contracts/settings";
import { PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useRef } from "react";
import { deriveAgentIdentity } from "@t3tools/client-runtime/state/agent-identity";

import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { useActiveWorkTabReveal } from "../hooks/useActiveWorkTabReveal";
import { MAX_PINNED_WORK_TABS, sameWorkTab, togglePinnedWorkTab } from "../pinnedWorkTabs";
import { useEnvironment } from "../state/environments";
import { useProject, useThreadShell } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { cn } from "../lib/utils";
import { useAgentIdentityTheme } from "./agent-identity/useAgentIdentityTheme";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { toastManager } from "./ui/toast";

function savePin(tab: PinnedWorkTab) {
  void persistClientSettingsUpdate((settings) => ({
    ...settings,
    pinnedWorkTabs: togglePinnedWorkTab(settings.pinnedWorkTabs, tab),
  })).catch(() => {
    toastManager.add({ type: "error", title: "Could not save work tabs" });
  });
}

function WorkTab({
  tab,
  active,
  index,
  onRemove,
  labelMode,
}: {
  tab: PinnedWorkTab;
  active: boolean;
  index: number;
  onRemove: (tab: PinnedWorkTab) => void;
  labelMode: ClientSettings["workTabLabelMode"];
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(tab);
  const environment = useEnvironment(tab.environmentId);
  const project = useProject(
    thread ? { environmentId: tab.environmentId, projectId: thread.projectId } : null,
  );
  const [theme, manualName] = useAgentIdentityTheme(tab);
  const title = thread?.title || tab.title;
  const agentName = thread
    ? deriveAgentIdentity(tab, thread.lineage, theme, manualName).name
    : null;
  const label = labelMode === "agent-name" ? agentName?.trim() || title : title;
  const openRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-active-work-tab={active ? "" : undefined}
      className="group/work-tab flex min-w-0 items-center gap-0.5"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              ref={openRef}
              variant={active ? "secondary" : "ghost-muted"}
              size="compact"
              aria-current={active ? "page" : undefined}
              aria-label={`Open work tab ${index + 1}: ${label === title ? title : `${label}: ${title}`}`}
              onClick={() => {
                void navigate({
                  to: "/$environmentId/$threadId",
                  params: buildThreadRouteParams(tab),
                });
              }}
              className="min-w-0 flex-1"
            />
          }
        >
          <span className="truncate">{label}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <span className="whitespace-pre-line">
            {[title, project?.title, environment?.label ?? tab.environmentId]
              .filter(Boolean)
              .join("\n")}
          </span>
        </TooltipPopup>
      </Tooltip>
      <Button
        variant="ghost-muted"
        size="icon-micro"
        aria-label={`Unpin work tab: ${title}`}
        onClick={() => {
          const next = openRef.current?.parentElement?.nextElementSibling?.querySelector("button");
          const previous =
            openRef.current?.parentElement?.previousElementSibling?.querySelector("button");
          const fallback = openRef.current
            ?.closest("nav")
            ?.querySelector<HTMLButtonElement>("[data-pin-current]");
          (next instanceof HTMLButtonElement
            ? next
            : previous instanceof HTMLButtonElement
              ? previous
              : fallback
          )?.focus();
          onRemove(tab);
        }}
      >
        <XIcon aria-hidden />
      </Button>
    </div>
  );
}

export function PinnedWorkTabs({
  className,
  maxRows = 1,
}: {
  className?: string;
  maxRows?: 1 | 2;
}) {
  const revealRef = useActiveWorkTabReveal();
  const params = useParams({ strict: false });
  const current = resolveThreadRouteRef(params);
  const thread = useThreadShell(current);
  const tabs = useClientSettings((settings) => settings.pinnedWorkTabs);
  const labelMode = useClientSettings((settings) => settings.workTabLabelMode);
  const hydrated = useClientSettingsHydrated();
  const pinned = current !== null && tabs.some((tab) => sameWorkTab(tab, current));
  if (!hydrated || (tabs.length === 0 && !thread)) return null;
  return (
    <nav
      ref={revealRef}
      aria-label="Pinned work tabs"
      className={cn("flex min-w-0 shrink items-center gap-1", "max-w-[50%] py-1", className)}
      onContextMenu={(event) => event.stopPropagation()}
    >
      <ScrollArea className="h-auto min-w-0 flex-1" scrollFade scrollFadePadding={false}>
        <div
          className="grid gap-x-2 gap-y-1 py-0.5"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, Math.ceil(tabs.length / maxRows))}, minmax(10rem, 1fr))`,
          }}
        >
          {tabs.map((tab, index) => (
            <WorkTab
              key={JSON.stringify([tab.environmentId, tab.threadId])}
              tab={tab}
              index={index}
              onRemove={savePin}
              labelMode={labelMode}
              active={current !== null && sameWorkTab(tab, current)}
            />
          ))}
        </div>
      </ScrollArea>
      {current && thread ? (
        <Button
          data-pin-current
          variant="ghost-muted"
          size="icon-xs"
          aria-label={pinned ? "Unpin current work tab" : "Pin current work tab"}
          aria-pressed={pinned}
          disabled={!pinned && tabs.length >= MAX_PINNED_WORK_TABS}
          title={
            !pinned && tabs.length >= MAX_PINNED_WORK_TABS ? "Eight work tabs pinned" : undefined
          }
          onClick={() => savePin({ ...current, title: thread.title })}
        >
          {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
        </Button>
      ) : null}
    </nav>
  );
}

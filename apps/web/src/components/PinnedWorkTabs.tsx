import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import type { PinnedWorkTab } from "@t3tools/contracts/settings";
import { PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { MAX_PINNED_WORK_TABS, sameWorkTab, togglePinnedWorkTab } from "../pinnedWorkTabs";
import { useEnvironment } from "../state/environments";
import { useThreadShell, useThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { cn } from "../lib/utils";
import { useWorkTabsPreview, type WorkTabsVariant } from "./work-tabs-preview/WorkTabsPreview";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

function savePin(tab: PinnedWorkTab) {
  void persistClientSettingsUpdate((settings) => ({
    ...settings,
    pinnedWorkTabs: togglePinnedWorkTab(settings.pinnedWorkTabs, tab),
  })).catch(() => {
    toastManager.add({ type: "error", title: "Could not save work tabs" });
  });
}

type DisplayWorkTab = PinnedWorkTab & { previewSlot?: number };

const previewTitles = [
  "Arbeits-Tabs",
  "Android: Verbindung nach Standby",
  "Megabase planen",
  "Btrfs-Speicherreserve",
  "Ergebniszustellung",
];

function WorkTab({
  tab,
  active,
  index,
  variant,
  onRemove,
}: {
  tab: DisplayWorkTab;
  active: boolean;
  index: number;
  variant: WorkTabsVariant | null;
  onRemove: (tab: DisplayWorkTab) => void;
}) {
  const navigate = useNavigate();
  const thread = useThreadShell(tab);
  const environment = useEnvironment(tab.environmentId);
  const title = variant ? tab.title : (thread?.title ?? tab.title);
  const openRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={cn(
        "group/work-tab flex shrink-0 items-center gap-0.5",
        variant === "b" && "w-48",
        variant === "c" && "w-28",
      )}
    >
      <Button
        ref={openRef}
        variant={active ? "secondary" : "ghost-muted"}
        size="compact"
        aria-current={active ? "page" : undefined}
        aria-label={`Open work tab ${index + 1}: ${title}`}
        title={`${title} · ${environment?.label ?? tab.environmentId}`}
        onClick={() => {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(tab),
            ...(variant
              ? { hash: `work-tabs=${variant}&work-tab-slot=${tab.previewSlot ?? 0}` }
              : {}),
          });
        }}
        className={variant ? "min-w-0 flex-1" : undefined}
      >
        <span className={variant === "b" ? "truncate" : "max-w-28 truncate"}>{title}</span>
      </Button>
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

export function PinnedWorkTabs() {
  const variant = useWorkTabsPreview();
  const shells = useThreadShells(variant !== null);
  const [previewTabs, setPreviewTabs] = useState<readonly DisplayWorkTab[] | null>(null);
  const params = useParams({ strict: false });
  const current = resolveThreadRouteRef(params);
  const thread = useThreadShell(current);
  const savedTabs = useClientSettings((settings) => settings.pinnedWorkTabs);
  const hash = useLocation({ select: (location) => location.hash });
  const previewSlot = Number(new URLSearchParams(hash.replace(/^#/, "")).get("work-tab-slot") ?? 0);
  const availableThreads = shells.filter((entry) => entry.archivedAt === null);
  const tabs: readonly DisplayWorkTab[] = variant
    ? (previewTabs ??
      previewTitles.flatMap((title, index) => {
        const target = availableThreads[index % availableThreads.length];
        return target
          ? [
              {
                environmentId: target.environmentId,
                threadId: target.id,
                title,
                previewSlot: index,
              },
            ]
          : [];
      }))
    : savedTabs;
  const toggle = (tab: DisplayWorkTab) => {
    if (variant) {
      if (tab.previewSlot !== undefined) {
        setPreviewTabs(tabs.filter((entry) => entry.previewSlot !== tab.previewSlot));
      } else {
        const existing =
          tabs.find((entry) => entry.previewSlot === previewSlot && sameWorkTab(entry, tab)) ??
          tabs.find((entry) => sameWorkTab(entry, tab));
        setPreviewTabs(
          existing
            ? tabs.filter((entry) => entry !== existing)
            : tabs.length < MAX_PINNED_WORK_TABS
              ? [
                  ...tabs,
                  {
                    ...tab,
                    previewSlot: Math.max(-1, ...tabs.map((entry) => entry.previewSlot ?? -1)) + 1,
                  },
                ]
              : tabs,
        );
      }
    } else savePin(tab);
  };
  const hydrated = useClientSettingsHydrated();
  const pinned = current !== null && tabs.some((tab) => sameWorkTab(tab, current));
  if ((!variant && !hydrated) || (tabs.length === 0 && !thread)) return null;
  return (
    <nav
      aria-label="Pinned work tabs"
      data-work-tabs-variant={variant ?? undefined}
      className={cn(
        "flex min-w-0 shrink items-center gap-1 overflow-x-auto",
        variant === "b"
          ? "w-full py-1"
          : variant === "c"
            ? "basis-[28rem] flex-1 py-1"
            : "max-w-[50%]",
      )}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {tabs.map((tab, index) => (
        <WorkTab
          key={JSON.stringify([tab.environmentId, tab.threadId, tab.previewSlot])}
          tab={tab}
          index={index}
          variant={variant}
          onRemove={toggle}
          active={
            current !== null &&
            sameWorkTab(tab, current) &&
            (!variant || tab.previewSlot === previewSlot)
          }
        />
      ))}
      {current && thread ? (
        <Button
          data-pin-current
          variant="ghost-muted"
          size="icon-xs"
          aria-label={pinned ? "Unpin current work tab" : "Pin current work tab"}
          aria-pressed={pinned}
          disabled={!pinned && tabs.length >= MAX_PINNED_WORK_TABS}
          title={
            !pinned && tabs.length >= MAX_PINNED_WORK_TABS ? "Five work tabs pinned" : undefined
          }
          onClick={() => toggle({ ...current, title: thread.title })}
        >
          {pinned ? <PinOffIcon aria-hidden /> : <PinIcon aria-hidden />}
        </Button>
      ) : null}
    </nav>
  );
}

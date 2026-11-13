import { useEffect, useState, type ReactNode } from "react";
import {
  AGENT_IDENTITY_THEMES,
  type DesktopPetSettings as PetSettings,
  type DesktopPetStatus,
} from "@t3tools/contracts";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleAlertIcon,
  EyeIcon,
  EyeOffIcon,
  KeyboardIcon,
  PawPrintIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  ScanEyeIcon,
  SparklesIcon,
  UploadIcon,
} from "lucide-react";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const shortcutErrors: Readonly<Record<string, string>> = {
  "niri-shortcut-invalid": "Use a letter, number or function key with Ctrl, Alt or Super.",
  "niri-config-unavailable": "Could not check the Niri configuration and its includes.",
  "niri-include-missing": "Niri must include crew-pet.kdl before this shortcut can be enabled.",
  "niri-shortcut-conflict": "This shortcut is already used in the Niri configuration.",
  "niri-file-not-owned": "The Niri pet include belongs to another profile or was edited manually.",
  "niri-config-changed": "The Niri configuration changed. Try saving the shortcut again.",
  "niri-validation-failed":
    "Niri could not validate the shortcut. The previous binding was preserved.",
};

function PetIconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function DesktopPetSettings() {
  const bridge = window.desktopBridge;
  const [status, setStatus] = useState<DesktopPetStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const threadContext = useHandleNewThread();
  const project = resolveThreadActionProjectRef({
    ...threadContext,
    activeThread: threadContext.activeThread ?? undefined,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe to the native companion's confirmed lifecycle and permission state.
  useEffect(() => {
    if (!bridge?.getPetStatus) return;
    let active = true;
    void bridge
      .getPetStatus()
      .then((value) => {
        if (active) setStatus(value);
      })
      .catch(() => {
        if (active) setError("Native companion is unavailable.");
      });
    const stop = bridge.onPetEvent((event) => {
      if (event.type === "status" && active) setStatus(event.status);
    });
    return () => {
      active = false;
      stop();
    };
  }, [bridge]);
  if (!bridge?.getPetStatus) return null;
  const run = (action: () => Promise<DesktopPetStatus>) => {
    setPending(true);
    setError(null);
    void action()
      .then(setStatus)
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : "";
        setError(
          Object.entries(shortcutErrors).find(([code]) => message.includes(code))?.[1] ??
            "Could not update the pet. Check the companion or selected pet pack.",
        );
      })
      .finally(() => setPending(false));
  };
  const change = (patch: Partial<PetSettings>) => {
    if (status) run(() => bridge.setPetSettings({ ...status.settings, ...patch }));
  };
  const cu = status?.native?.computerUse;
  const character = status?.native?.character;
  const requestedSpecies = status?.preferredSpecies ?? null;
  const speciesLabel = AGENT_IDENTITY_THEMES[requestedSpecies ?? "weasel"].label;
  const characterDescription = status?.customPet
    ? status.customPet
    : status?.connection !== "ready"
      ? "Not connected"
      : status.capabilities?.builtinPets === undefined
        ? "Update the companion to match your animal avatar"
        : !character || character.requestedSpecies !== requestedSpecies
          ? "Selecting character…"
          : character.source === "unavailable"
            ? `${speciesLabel}: no pet available yet`
            : character.name;
  const connection =
    status?.connection === "ready"
      ? "Connected"
      : status?.connection === "unsupported"
        ? "Native pet requires Linux and Niri"
        : status?.connection === "starting"
          ? "Connecting…"
          : status?.error === "companion-not-found"
            ? "Companion not found"
            : status
              ? "Disconnected"
              : "Connecting…";
  const privacy = cu
    ? cu.observationMode === "disabled"
      ? "Screenshots and AT-SPI disabled"
      : cu.observationActive
        ? "Screenshots and AT-SPI active"
        : "Screenshots and AT-SPI allowed; not capturing"
    : "No confirmed Computer Use session";
  const privacyLabel = cu
    ? cu.observationMode === "disabled"
      ? "Off"
      : cu.observationActive
        ? "Capturing"
        : "Allowed · idle"
    : "Not confirmed";
  const create = () => {
    if (!project || !idea.trim()) return;
    const prompt = `Create an animated desktop pet: ${idea.trim()}\nFirst verify that image-generation tools are available. If unavailable, report that limitation instead of fabricating an image. Use the existing image-generation workflow. Create a crew-pet/v1 folder containing only pet.json and pet.png. PNG must be 8-bit RGBA, 4 columns by 8 rows, square frames from 64 to 512 pixels. pet.json: schema=1, name (1–60 characters, no control characters), frameWidth, frameHeight, sheet="pet.png", states idle, working, reading, lookingAway, waiting, attention, success, error. Each state: unique row 0–7, frames=4, fps=6, loop=false. LookingAway covers the eyes with paws/hands and contains no text. Keep the same character across frames. Save both files and return the folder path for Settings > General > Desktop pet > Import. Do not install anything or enter credentials.`;
    void threadContext.handleNewThread(project, { prompt });
  };
  return (
    <SettingsSection
      id="desktop-pet"
      title="Desktop pet"
      icon={<PawPrintIcon aria-hidden className="size-4" />}
      headerAction={
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <span tabIndex={0} role="status" aria-label={connection}>
                  <Badge variant={status?.connection === "ready" ? "success" : "secondary"}>
                    {status?.connection === "ready" ? (
                      <CircleCheckIcon aria-hidden />
                    ) : (
                      <CircleAlertIcon aria-hidden />
                    )}
                    {status?.connection === "ready" ? "Connected" : connection}
                  </Badge>
                </span>
              }
            />
            <TooltipPopup>{status?.error ?? connection}</TooltipPopup>
          </Tooltip>
          <PetIconButton
            label="Reconnect companion"
            disabled={!status || pending}
            onClick={() => run(() => bridge.reconnectPet())}
          >
            <RefreshCwIcon aria-hidden />
          </PetIconButton>
        </div>
      }
    >
      <SettingsRow
        title="Character"
        description={characterDescription}
        control={
          <div className="flex items-center gap-1">
            <PetIconButton
              label="Import animated pet"
              disabled={pending || !status}
              onClick={() => run(() => bridge.importPet())}
            >
              <UploadIcon aria-hidden />
            </PetIconButton>
            <PetIconButton
              label="Follow animal avatar"
              disabled={pending || !status?.customPet}
              onClick={() => run(() => bridge.resetPet())}
            >
              <RotateCcwIcon aria-hidden />
            </PetIconButton>
          </div>
        }
      />
      <SettingsRow
        title="Always show pet"
        control={
          <div className="flex items-center gap-3">
            <PetIconButton
              label={
                status?.settings.visible
                  ? "Hide reminders (Computer Use stays visible)"
                  : "Show reminders"
              }
              disabled={status?.connection !== "ready" || !status.settings.persistent}
              onClick={() => void bridge.togglePet()}
            >
              {status?.settings.visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
            </PetIconButton>
            <Switch
              aria-label="Always show pet"
              checked={status?.settings.persistent ?? false}
              disabled={!status || pending}
              onCheckedChange={(persistent) => change({ persistent })}
            />
          </div>
        }
      />
      <SettingsRow
        title="Screen access"
        control={
          <Tooltip>
            <TooltipTrigger render={<span tabIndex={0} aria-label={privacy} />}>
              <Badge
                variant={
                  cu?.observationMode === "disabled"
                    ? "secondary"
                    : cu?.observationActive
                      ? "warning"
                      : "outline"
                }
              >
                {cu?.observationMode === "disabled" ? (
                  <EyeOffIcon aria-hidden />
                ) : (
                  <ScanEyeIcon aria-hidden />
                )}
                {privacyLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipPopup>{privacy}</TooltipPopup>
          </Tooltip>
        }
      />
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <KeyboardIcon aria-hidden className="size-4" />
            Shortcut
          </span>
        }
        description={
          status?.shortcutError && shortcutErrors[status.shortcutError]
            ? shortcutErrors[status.shortcutError]
            : status?.settings.shortcut && !status.shortcutRegistered
              ? "Global shortcut unavailable on this desktop or already in use."
              : undefined
        }
        control={
          <DraftInput
            aria-label="Pet global shortcut"
            placeholder="Ctrl+Alt+P"
            value={status?.settings.shortcut ?? ""}
            disabled={!status || pending}
            onCommit={(shortcut) => change({ shortcut })}
          />
        }
      />
      <SettingsRow
        title="Reduce motion"
        control={
          <Switch
            aria-label="Reduce pet motion"
            checked={status?.settings.reducedMotion ?? false}
            disabled={!status || pending}
            onCheckedChange={(reducedMotion) => change({ reducedMotion })}
          />
        }
      />
      <SettingsRow
        title="Create a pet"
        control={
          <div className="flex gap-2">
            <Input
              aria-label="Pet description"
              placeholder="A sleepy little fox…"
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
            />
            <Button
              size="sm"
              variant="secondary"
              aria-label="Create pet with agent"
              disabled={!project || !idea.trim()}
              onClick={create}
            >
              <SparklesIcon aria-hidden />
              Create draft
            </Button>
          </div>
        }
      />
      <Collapsible open={advanced} onOpenChange={setAdvanced}>
        <div className="px-3 py-2 sm:px-4">
          <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
            Advanced
            <ChevronDownIcon aria-hidden className={advanced ? "rotate-180" : undefined} />
          </CollapsibleTrigger>
        </div>
        <CollapsiblePanel animate={false}>
          <SettingsRow
            title="Companion executable"
            control={
              <DraftInput
                aria-label="Pet companion executable"
                value={status?.settings.executable ?? "weasel-desktop-pet"}
                disabled={!status || pending}
                onCommit={(executable) => change({ executable })}
              />
            }
          />
        </CollapsiblePanel>
      </Collapsible>
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

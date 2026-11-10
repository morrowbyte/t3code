import { useEffect, useState } from "react";
import type { DesktopPetSettings as PetSettings, DesktopPetStatus } from "@t3tools/contracts";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopPetSettings() {
  const bridge = window.desktopBridge;
  const [status, setStatus] = useState<DesktopPetStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idea, setIdea] = useState("");
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
      .catch(() => setError("Could not update the pet. Check the companion or selected pet pack."))
      .finally(() => setPending(false));
  };
  const change = (patch: Partial<PetSettings>) => {
    if (status) run(() => bridge.setPetSettings({ ...status.settings, ...patch }));
  };
  const cu = status?.native?.computerUse;
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
  const create = () => {
    if (!project || !idea.trim()) return;
    const prompt = `Create an animated desktop pet: ${idea.trim()}\nFirst verify that image-generation tools are available. If unavailable, report that limitation instead of fabricating an image. Use the existing image-generation workflow. Create a crew-pet/v1 folder containing only pet.json and pet.png. PNG must be 8-bit RGBA, 4 columns by 8 rows, square frames from 64 to 512 pixels. pet.json: schema=1, name (1–60 characters, no control characters), frameWidth, frameHeight, sheet="pet.png", states idle, working, reading, lookingAway, waiting, attention, success, error. Each state: unique row 0–7, frames=4, fps=6, loop=false. LookingAway covers the eyes with paws/hands and contains no text. Keep the same character across frames. Save both files and return the folder path for Settings > General > Desktop pet > Import. Do not install anything or enter credentials.`;
    void threadContext.handleNewThread(project, { prompt });
  };
  return (
    <SettingsSection id="desktop-pet" title="Desktop pet">
      <SettingsRow
        title="Always show pet"
        description="Off by default. Computer Use can still show its task-bound pet."
        control={
          <Switch
            aria-label="Always show pet"
            checked={status?.settings.persistent ?? false}
            disabled={!status || pending}
            onCheckedChange={(persistent) => change({ persistent })}
          />
        }
      />
      <SettingsRow
        title="Companion"
        description={connection}
        status={status?.error && status.error !== "companion-not-found" ? status.error : undefined}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={!status || pending}
            onClick={() => run(() => bridge.setPetSettings(status!.settings))}
          >
            Reconnect
          </Button>
        }
      />
      <SettingsRow title="Screen access" description={privacy} />
      <SettingsRow
        title="Show or hide"
        description="The task-bound Computer Use privacy indicator stays visible."
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={status?.connection !== "ready"}
            onClick={() => void bridge.togglePet()}
          >
            Toggle pet
          </Button>
        }
      />
      <SettingsRow
        title="Global shortcut"
        description={
          status?.settings.shortcut && !status.shortcutRegistered
            ? "Shortcut unavailable. Choose another combination."
            : "Unassigned by default."
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
        title="Pet"
        description={status?.customPet ?? "Built-in pet"}
        control={
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={pending || !status}
              onClick={() => run(() => bridge.importPet())}
            >
              Import…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={pending || !status?.customPet}
              onClick={() => run(() => bridge.resetPet())}
            >
              Use built-in
            </Button>
          </div>
        }
      />
      <SettingsRow
        title="Create a pet"
        description="Prepare an agent draft using your chosen model and available image tools."
        control={
          <div className="flex gap-2">
            <Input
              aria-label="Pet description"
              placeholder="Describe your pet"
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!project || !idea.trim()}
              onClick={create}
            >
              Create with agent…
            </Button>
          </div>
        }
      />
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
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}

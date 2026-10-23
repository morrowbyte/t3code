import { useAtomValue } from "@effect/atom-react";
import type { ApprovalReviewOrderReadiness, EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "../../hooks/useSettings";
import { useEnvironments } from "../../state/environments";
import { approvalOrderEnvironment } from "../../state/approvalOrders";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export function HostOrderSettings() {
  const enabled = useClientSettings((settings) => settings.hostOrderEntryEnabled);
  const hydrated = useClientSettingsHydrated();
  const { environments } = useEnvironments();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(value: boolean) {
    if (!hydrated || saving) return;
    setSaving(true);
    setError(null);
    try {
      await persistClientSettingsUpdate((current) => ({
        ...current,
        hostOrderEntryEnabled: value,
      }));
    } catch {
      setError("Could not save protected task visibility. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection id="protected-tasks" title="Protected tasks">
      <SettingsRow
        title="Show protected tasks"
        description="Adds a protected task entry to chat on this client."
        control={
          <Switch
            aria-label="Show protected tasks"
            checked={hydrated && enabled === true}
            disabled={!hydrated || saving}
            onCheckedChange={(value) => void save(value)}
          />
        }
      />
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="space-y-3 px-4 py-3 text-sm">
        <p className="text-muted-foreground">
          Host activation and permissions are managed by the host operator. Hiding this entry does
          not cancel existing orders or disable host protection.
        </p>
        {hydrated && enabled ? (
          environments.length > 0 ? (
            environments.map((entry) => (
              <HostSetupStatus
                key={entry.environmentId}
                environmentId={entry.environmentId}
                label={entry.label}
                connected={entry.connection.phase === "connected"}
              />
            ))
          ) : (
            <p role="status">No host connection is configured.</p>
          )
        ) : null}
        <details className="text-muted-foreground">
          <summary>Host setup and protection boundaries</summary>
          <p className="mt-2">
            The operator must explicitly enable the host policy and bind the human session, control
            conversation and execution destination. Each external action still needs its own
            approval. This setting configures neither VM network isolation nor restrictions on
            agents running locally on the host.
          </p>
        </details>
      </div>
    </SettingsSection>
  );
}

function HostSetupStatus({
  environmentId,
  label,
  connected,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
}) {
  const canCheck = useAtomValue(approvalOrderEnvironment.readiness.permissionAtom(environmentId));
  const check = useAtomCommand(approvalOrderEnvironment.readiness, { reportFailure: false });
  const [readiness, setReadiness] = useState<ApprovalReviewOrderReadiness | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    if (!connected || !canCheck || pending) return;
    setPending(true);
    setError(null);
    setReadiness(null);
    try {
      const result = await check({ environmentId, input: {} });
      if (result._tag === "Success") setReadiness(result.value);
      else {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Host status unavailable.");
      }
    } catch {
      setError("Host status unavailable.");
    } finally {
      setPending(false);
    }
  }

  const reasons = {
    ready: "Connected · host authorization ready",
    "feature-disabled": readiness?.configured
      ? "Configured · disabled by host operator"
      : "Host protection is not activated",
    "human-authority-unconfigured": "Human authority is not configured",
    "human-authority-required": "This session has no human authority",
    "channel-unconfigured": "No execution destination is configured",
    "forward-unavailable": "Configured execution destination is unavailable",
  };
  const status = !connected
    ? "Offline"
    : !canCheck
      ? "Missing permission to check host setup"
      : pending
        ? "Checking host setup…"
        : error
          ? "Host status unavailable"
          : readiness
            ? reasons[readiness.reason]
            : "Setup not checked";

  return (
    <section
      aria-label={`Host setup: ${label}`}
      className="space-y-2 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 break-words font-medium">{label}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!connected || !canCheck || pending}
          onClick={() => void refresh()}
        >
          Check host setup
        </Button>
      </div>
      <p role="status" className="text-muted-foreground">
        {status}
      </p>
      {readiness?.sourceKind === "synthetic" ? <p>Synthetic test · execution disabled</p> : null}
      {readiness?.channels.map((channel) => (
        <p key={channel.vmId}>
          {channel.label} · {channel.ready ? "connected" : "unavailable"}
        </p>
      ))}
      {error ? (
        <details>
          <summary>Error details</summary>
          <p className="break-words">{error}</p>
        </details>
      ) : null}
    </section>
  );
}

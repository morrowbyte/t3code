import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  isHostUpdateTerminal,
  type EnvironmentId,
  type HostUpdateRecord,
  type HostUpdateStatus,
} from "@t3tools/contracts";
import { useState } from "react";
import { requestConfirmDialog } from "~/confirmDialog";
import { hostUpdateHistory, deleteHostUpdateHistory } from "~/state/updateHistory";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsSection } from "./settingsLayout";

const statusLabels: Record<HostUpdateStatus, string> = {
  downloading: "Downloading",
  ready: "Ready to install",
  installing: "Installing",
  "awaiting-restart": "Awaiting restart confirmation",
  succeeded: "Restarted on target version",
  failed: "Failed",
  interrupted: "Interrupted",
  "rolled-back": "Rolled back",
};
const time = (value: string | null) =>
  value === null ? "Unknown" : new Date(value).toLocaleString();

export function UpdateHistoryPanel() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsSection id="update-history" title="Update history">
      {connectedEnvironments.length === 0 && (
        <p className="px-3 py-2 text-sm">Connect to a host to read its update history.</p>
      )}
      {connectedEnvironments.map((environment) =>
        environment.serverConfig?.environment.capabilities.updateHistory === true ? (
          <HostHistory
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ) : (
          <p key={environment.environmentId} className="px-3 py-2 text-sm text-muted-foreground">
            {environment.label}: this host version does not support saved update history.
          </p>
        ),
      )}
    </SettingsSection>
  );
}

function HostHistory({ environmentId, label }: { environmentId: EnvironmentId; label: string }) {
  const query = hostUpdateHistory({ environmentId, input: {} });
  const result = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  const allowed = useAtomValue(deleteHostUpdateHistory.permissionAtom(environmentId));
  const remove = useAtomCommand(deleteHostUpdateHistory);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [visible, setVisible] = useState(10);
  const deleteEntry = async (entry: HostUpdateRecord) => {
    if (
      !allowed ||
      !(await requestConfirmDialog(
        `Delete this ${entry.component} update record from ${label}? This permanently removes its saved history.`,
        { variant: "destructive" },
      ))
    )
      return;
    setDeleting(entry.id);
    try {
      await remove({ environmentId, input: { id: entry.id, component: entry.component } });
    } finally {
      setDeleting(null);
      refresh();
    }
  };
  return (
    <div className="space-y-2 border-t border-border/60 px-3 py-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{label}</h3>
        <Button variant="outline" size="xs" onClick={refresh}>
          Refresh
        </Button>
      </div>
      {result._tag === "Initial" && (
        <p role="status" className="text-sm">
          Loading update history…
        </p>
      )}
      {result._tag === "Failure" && (
        <p role="alert" className="text-sm text-destructive">
          Update history could not be read. Check this host’s connection and data directory, then
          refresh.
        </p>
      )}
      {result._tag === "Success" && (
        <>
          {result.value.desktop === "unavailable" && (
            <p role="status" className="text-sm text-muted-foreground">
              {result.value.desktopError ??
                "Desktop history is unavailable until this host’s desktop reconnects."}
            </p>
          )}
          {result.value.entries.length === 0 && (
            <p className="text-sm text-muted-foreground">No saved update results on this host.</p>
          )}
          {result.value.entries.slice(0, visible).map((entry) => (
            <div
              key={`${entry.component}:${entry.id}`}
              className="space-y-1 rounded-md border border-border/60 p-3 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium">
                  {entry.component === "desktop" ? "Desktop app" : "Server"} ·{" "}
                  {statusLabels[entry.status]}
                </p>
                {isHostUpdateTerminal(entry.status) && (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={!allowed || deleting !== null}
                    aria-label={`Delete ${entry.component} update record from ${label}`}
                    onClick={() => void deleteEntry(entry)}
                  >
                    Delete
                  </Button>
                )}
              </div>
              <p>
                {entry.fromVersion ?? "Unknown version"} → {entry.targetVersion ?? "Unknown target"}
              </p>
              <p className="text-muted-foreground">
                Running version observed: {entry.observedVersion ?? "Not confirmed"}
              </p>
              <p className="text-xs text-muted-foreground">
                Started: {time(entry.startedAt)} · Last observed: {time(entry.updatedAt)}
              </p>
              {entry.completedAt && (
                <p className="text-xs text-muted-foreground">
                  Result recorded: {time(entry.completedAt)}
                </p>
              )}
              {entry.error && (
                <p role="alert" className="whitespace-pre-wrap break-words text-destructive">
                  {entry.error}
                </p>
              )}
            </div>
          ))}
          {result.value.entries.length > visible && (
            <Button variant="outline" size="xs" onClick={() => setVisible(visible + 20)}>
              Show older results
            </Button>
          )}
        </>
      )}
    </div>
  );
}

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  resolveProjectGroupingMode,
} from "../../logicalProject";
import { newProjectId } from "../../lib/utils";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  sharedProjectCloneSource,
  sharedProjectDestinationError,
  sharedProjectHostBlockReason,
  type SharedProjectHost,
} from "./SharedProjectSetup.logic";

export function SharedProjectSetup({ group }: { group: SidebarProjectSnapshot }) {
  const { environments } = useEnvironments();
  const readable = useEnvironmentsWithScope(environments, AuthOrchestrationReadScope);
  const writable = useEnvironmentsWithScope(environments, AuthSourceControlWriteScope);
  const creatable = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const settings = useClientSettings();
  const projects = useProjects();
  const [open, setOpen] = useState(false);
  const readableMembers = group.memberProjects.filter(
    (member) =>
      readable.has(member.environmentId) &&
      environments.some(
        (environment) =>
          environment.environmentId === member.environmentId &&
          environment.connection.phase === "connected",
      ),
  );
  const source = readableMembers.find(
    (member) =>
      !("error" in sharedProjectCloneSource(member)) &&
      resolveProjectGroupingMode(member, settings) !== "separate",
  );
  const sourceForFeedback = source ?? readableMembers[0];
  const cloneSource = sourceForFeedback
    ? sharedProjectCloneSource(sourceForFeedback)
    : { error: "Connect a host with permission to read this repository." };
  const sourceError =
    "error" in cloneSource
      ? cloneSource.error
      : sourceForFeedback && resolveProjectGroupingMode(sourceForFeedback, settings) === "separate"
        ? "Enable repository grouping for this project before adding a host."
        : null;
  const hosts: SharedProjectHost[] = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    connected: environment.connection.phase === "connected",
    platform: environment.serverConfig?.environment?.platform?.os,
    canCreateProject: creatable.has(environment.environmentId),
    canWriteSourceControl: writable.has(environment.environmentId),
    supportsTrackedClones:
      environment.serverConfig?.environment?.capabilities?.projectCloneTracking === true,
    hasCheckout: projects.some(
      (project) =>
        project.environmentId === environment.environmentId &&
        source &&
        deriveLogicalProjectKeyFromSettings(project, settings) ===
          deriveLogicalProjectKeyFromSettings(source, settings),
    ),
  }));
  return (
    <SettingsSection title="Shared project">
      <SettingsRow
        title="Set up on another host"
        description={
          sourceError ?? "Clone this repository into a new checkout on a connected host."
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={sourceError !== null}
            onClick={() => setOpen(true)}
          >
            Add host
          </Button>
        }
      />
      <Dialog open={open} onOpenChange={setOpen}>
        {open && source && !("error" in cloneSource) ? (
          <SharedProjectSetupForm
            key={`${source.environmentId}:${source.workspaceRoot}`}
            source={source}
            remoteUrl={cloneSource.remoteUrl}
            hosts={hosts}
            projectName={group.displayName}
            sourceError={sourceError}
            onClose={() => setOpen(false)}
          />
        ) : null}
      </Dialog>
    </SettingsSection>
  );
}

function SharedProjectSetupForm({
  source,
  remoteUrl,
  hosts,
  projectName,
  sourceError,
  onClose,
}: {
  source: { environmentId: EnvironmentId; workspaceRoot: string };
  remoteUrl: string;
  hosts: readonly SharedProjectHost[];
  projectName: string;
  sourceError: string | null;
  onClose: () => void;
}) {
  const projects = useProjects();
  const settings = useClientSettings();
  const [hostId, setHostId] = useState<EnvironmentId | null>(null);
  const [path, setPath] = useState("");
  const [remoteOnlyAccepted, setRemoteOnlyAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const startClone = useAtomCommand(sourceControlEnvironment.startProjectClone, {
    reportFailure: false,
  });
  const host = hosts.find((entry) => entry.environmentId === hostId);
  const groupingError =
    host &&
    path.trim() &&
    resolveProjectGroupingMode(
      { environmentId: host.environmentId, workspaceRoot: path.trim() },
      settings,
    ) === "separate"
      ? "Enable repository grouping for this checkout path before adding a host."
      : null;
  const blockReason =
    sourceError ??
    (!hosts.some((entry) => sharedProjectHostBlockReason(entry) === null)
      ? "Connect another host with project and source-control permissions to continue."
      : null) ??
    (host ? sharedProjectHostBlockReason(host) : "Choose a host.") ??
    groupingError ??
    sharedProjectDestinationError(
      path,
      host?.platform,
      projects.filter((project) => project.environmentId === hostId),
    ) ??
    (!remoteOnlyAccepted ? "Confirm that only remote commits will be cloned." : null);
  const submit = async () => {
    if (inFlight.current || blockReason || !host) return;
    if (
      !readEnvironmentScope(host.environmentId, AuthSourceControlWriteScope) ||
      !readEnvironmentScope(host.environmentId, AuthOrchestrationOperateScope) ||
      !readEnvironmentScope(source.environmentId, AuthOrchestrationReadScope)
    ) {
      setError("Connection permissions changed. Reconnect and try again.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await startClone({
        environmentId: host.environmentId,
        input: {
          projectId: newProjectId(),
          title: projectName,
          createdAt: new Date().toISOString(),
          remoteUrl,
          destinationPath: path.trim(),
        },
      });
      if (result._tag === "Success") onClose();
      else if (!isAtomCommandInterrupted(result)) {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not start the clone.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the clone.");
    }
    inFlight.current = false;
    setPending(false);
  };
  return (
    <DialogPopup>
      <DialogHeader>
        <div className="pr-8">
          <DialogTitle>Set up {projectName} on another host</DialogTitle>
        </div>
        <DialogDescription>
          Clone remote commits. Local changes and host scripts are not copied.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4 px-6 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-1.5">
          <label htmlFor="shared-project-host" className="text-sm font-medium">
            Host
          </label>
          <Select
            value={hostId}
            onValueChange={(value) => {
              setHostId(value);
              setPath("");
              setError(null);
            }}
            disabled={pending}
          >
            <SelectTrigger id="shared-project-host">
              <SelectValue placeholder="Choose a host" />
            </SelectTrigger>
            <SelectPopup>
              {hosts.map((entry) => {
                const reason = sharedProjectHostBlockReason(entry);
                return (
                  <SelectItem
                    key={entry.environmentId}
                    value={entry.environmentId}
                    disabled={reason !== null}
                  >
                    {entry.label}
                    {reason ? ` · ${reason}` : ""}
                  </SelectItem>
                );
              })}
            </SelectPopup>
          </Select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="shared-project-path" className="text-sm font-medium">
            New checkout path on {host?.label ?? "host"}
          </label>
          <Input
            id="shared-project-path"
            value={path}
            disabled={!host || pending}
            placeholder={
              host?.platform === "windows"
                ? "C:\\Projects\\repository"
                : "/home/user/projects/repository"
            }
            onChange={(event) => {
              setPath(event.target.value);
              setError(null);
            }}
          />
        </div>
        <p className="break-all text-xs text-muted-foreground">{remoteUrl}</p>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={remoteOnlyAccepted}
            disabled={pending}
            onCheckedChange={setRemoteOnlyAccepted}
          />
          Clone remote commits only; keep local changes on the source host.
        </label>
        {error || blockReason ? (
          <p role={error ? "alert" : "status"} className="text-sm text-muted-foreground">
            {error ?? blockReason}
          </p>
        ) : null}
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || blockReason !== null}>
            {pending ? "Starting clone…" : "Clone on host"}
          </Button>
        </DialogFooter>
      </form>
    </DialogPopup>
  );
}

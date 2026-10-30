import { newMessageId } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BOAT_PROJECT,
  AuthPreviewOperateScope,
  type BoatAction,
  type BoatDefaults,
  type BoatProjectConfig,
  type BoatState,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useEffect, useEffectEvent, useState } from "react";
import { boatEnvironment } from "../../state/boat";
import { useEnvironmentScope } from "../../state/session";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { AdvancedSettings } from "./AdvancedSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { ServerBrowserSurface } from "../../browser/ServerBrowserSurface";

const dollars = (value: number) =>
  new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);

export function BoatSettingsPanel() {
  const { target } = useSettingsScope();
  return target ? <BoatPanel environmentId={target.environmentId} editable /> : null;
}

export function BoatUsagePanel() {
  const environmentId = usePrimaryEnvironmentId();
  return environmentId ? <BoatPanel environmentId={environmentId} /> : null;
}

function ProjectForm({
  config,
  defaults,
  save,
  busy,
}: {
  config: BoatProjectConfig;
  defaults: BoatDefaults;
  save: (config: BoatProjectConfig) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(config);
  const machineLabels = {
    small: "Small · 2 CPU / 4 GB",
    default: "Default · 4 CPU / 8 GB",
    large: "Large · 8 CPU / 16 GB",
    xlarge: "XLarge · 16 CPU / 32 GB",
  };
  return (
    <>
      <SettingsRow
        title="Cloud environment"
        control={
          <Switch
            checked={draft.enabled}
            disabled={busy}
            aria-label="Use Boat for this project"
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        }
      />
      <SettingsRow
        title="Preview"
        control={
          <Select
            value={draft.previewKind}
            onValueChange={(value) => {
              if (value === "web" || value === "android")
                setDraft({ ...draft, previewKind: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Boat preview type">
              <SelectValue>
                {draft.previewKind === "android" ? "Android emulator" : "Web"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="web">Web</SelectItem>
              <SelectItem value="android">Android emulator</SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Machine"
        control={
          <Select
            value={draft.size}
            onValueChange={(value) => {
              if (value) setDraft({ ...draft, size: value as BoatProjectConfig["size"] });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Boat machine size">
              <SelectValue>{machineLabels[draft.size]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {Object.entries(machineLabels).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Use default timeouts"
        control={
          <Switch
            checked={draft.inheritDefaults}
            aria-label="Use default timeouts"
            onCheckedChange={(inheritDefaults) => setDraft({ ...draft, inheritDefaults })}
          />
        }
      />
      <SettingsRow
        title="Auto-stop"
        description="Minutes"
        control={
          <div className="w-24">
            <Input
              size="sm"
              aria-label="Auto-stop minutes"
              type="number"
              min={1}
              max={1440}
              value={draft.inheritDefaults ? defaults.ttlMinutes : draft.ttlMinutes}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  ttlMinutes: Number(event.target.value),
                  inheritDefaults: false,
                })
              }
            />
          </div>
        }
      />
      <SettingsRow
        title="Keep stopped disk"
        description="Days; 0 deletes it after stopping"
        control={
          <div className="w-24">
            <Input
              size="sm"
              type="number"
              min={0}
              max={14}
              aria-label="Keep stopped disk days"
              value={draft.inheritDefaults ? defaults.retentionDays : draft.retentionDays}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  retentionDays: Number(event.target.value),
                  inheritDefaults: false,
                })
              }
            />
          </div>
        }
      />
      <SettingsRow
        title="Monthly project budget"
        description="USD"
        control={
          <div className="w-24">
            <Input
              size="sm"
              aria-label="Monthly project budget USD"
              type="number"
              min={0.1}
              step={0.1}
              value={draft.budgetUsd}
              onChange={(event) => setDraft({ ...draft, budgetUsd: Number(event.target.value) })}
            />
          </div>
        }
      />
      <SettingsRow
        title="CI/CD"
        control={
          <Switch
            checked={draft.ciEnabled}
            disabled={busy}
            aria-label="Prepare Boat CI workflow"
            onCheckedChange={(ciEnabled) => setDraft({ ...draft, ciEnabled })}
          />
        }
      />
      <AdvancedSettings targetIds={["boat-startup", "boat-ci"]}>
        <SettingsRow
          title="Concurrent machines"
          control={
            <div className="w-24">
              <Input
                size="sm"
                aria-label="Concurrent machines"
                type="number"
                min={1}
                max={10}
                value={draft.maxConcurrent}
                onChange={(event) =>
                  setDraft({ ...draft, maxConcurrent: Number(event.target.value) })
                }
              />
            </div>
          }
        />
        {(
          [
            ["snapshot", "Snapshot", "Optional prepared environment"],
            ["setupCommand", "Setup command", "Detected automatically when empty"],
            ["devCommand", "Dev command", "Detected automatically when empty"],
          ] as const
        ).map(([field, label, placeholder]) => (
          <SettingsRow
            key={field}
            title={label}
            id={field === "devCommand" ? "boat-startup" : undefined}
            control={
              <div className="w-full sm:w-80">
                <Input
                  size="sm"
                  font="mono"
                  aria-label={label}
                  value={draft[field]}
                  placeholder={placeholder}
                  onChange={(event) => setDraft({ ...draft, [field]: event.target.value })}
                />
              </div>
            }
          />
        ))}
        <SettingsRow
          title="Preview port"
          control={
            <div className="w-24">
              <Input
                size="sm"
                aria-label="Preview port"
                type="number"
                min={1}
                max={65535}
                value={draft.port}
                onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })}
              />
            </div>
          }
        />
        {draft.ciEnabled && (
          <>
            <SettingsRow
              id="boat-ci"
              title="CI command"
              control={
                <div className="w-full sm:w-80">
                  <Input
                    size="sm"
                    font="mono"
                    aria-label="CI command"
                    value={draft.ciCommand}
                    onChange={(event) => setDraft({ ...draft, ciCommand: event.target.value })}
                  />
                </div>
              }
            />
            <SettingsRow
              title="Release command"
              description="Manual workflow dispatch"
              control={
                <div className="w-full sm:w-80">
                  <Input
                    size="sm"
                    font="mono"
                    aria-label="Release command"
                    value={draft.releaseCommand}
                    onChange={(event) => setDraft({ ...draft, releaseCommand: event.target.value })}
                  />
                </div>
              }
            />
          </>
        )}
      </AdvancedSettings>
      <SettingsRow
        title="Project configuration"
        description={
          draft.ciEnabled ? "Commit and push the generated workflow to activate CI/CD." : undefined
        }
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => save(draft)}
          >
            Save project
          </Button>
        }
      />
    </>
  );
}

function BoatDefaultsForm({
  defaults,
  busy,
  save,
}: {
  defaults: BoatDefaults;
  busy: boolean;
  save: (defaults: BoatDefaults) => void;
}) {
  const [draft, setDraft] = useState(defaults);
  return (
    <>
      <SettingsRow
        title="Default auto-stop"
        description="Minutes"
        control={
          <div className="w-24">
            <Input
              size="sm"
              type="number"
              min={1}
              max={1440}
              aria-label="Default auto-stop minutes"
              value={draft.ttlMinutes}
              onChange={(event) => setDraft({ ...draft, ttlMinutes: Number(event.target.value) })}
            />
          </div>
        }
      />
      <SettingsRow
        title="Default disk retention"
        description="Free for up to 14 days after stopping"
        control={
          <div className="w-24">
            <Input
              size="sm"
              type="number"
              min={0}
              max={14}
              aria-label="Default disk retention days"
              value={draft.retentionDays}
              onChange={(event) =>
                setDraft({ ...draft, retentionDays: Number(event.target.value) })
              }
            />
          </div>
        }
      />
      <SettingsRow
        title="Default limits"
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={() => save(draft)}>
            Save defaults
          </Button>
        }
      />
    </>
  );
}

function BoatPanel({
  environmentId,
  editable = false,
}: {
  environmentId: EnvironmentId;
  editable?: boolean;
}) {
  const threads = useThreadShells();
  const canPreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [state, setState] = useState<BoatState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [editingKey, setEditingKey] = useState(false);
  const [projectId, setProjectId] = useState<ProjectId | "">("");
  const read = useAtomCommand(boatEnvironment.read, { reportFailure: false });
  const connect = useAtomCommand(boatEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(boatEnvironment.disconnect, { reportFailure: false });
  const configureDefaults = useAtomCommand(boatEnvironment.defaults, { reportFailure: false });
  const configure = useAtomCommand(boatEnvironment.configure, { reportFailure: false });
  const operate = useAtomCommand(boatEnvironment.operate, { reportFailure: false });
  const canConfigure = useAtomValue(boatEnvironment.configure.permissionAtom(environmentId));
  const canOperate = useAtomValue(boatEnvironment.operate.permissionAtom(environmentId));
  const canConnect = useAtomValue(boatEnvironment.connect.permissionAtom(environmentId));
  const selectedProject = projectId || projects[0]?.id;

  const refreshState = useEffectEvent(async (targetEnvironment: EnvironmentId) =>
    read({ environmentId: targetEnvironment, input: {} }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refresh external Boat state while this panel is mounted.
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await refreshState(environmentId);
        if (!active) return;
        if (result._tag === "Success") {
          setState(result.value);
          setError("");
        } else setError("Could not refresh Boat. Check the account and connection.");
      } catch {
        setError("Boat connection interrupted. Refresh and try again.");
      }
      pending = false;
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [environmentId]);

  const act = async (action: BoatAction) => {
    const startsEnvironment = action.action === "start" || action.action === "resume";
    setBusy(true);
    const perform = async () => {
      const thread = canPreview
        ? threads.find(
            (item) => item.environmentId === environmentId && item.projectId === action.projectId,
          )
        : undefined;
      let result = await operate({
        environmentId,
        input: { ...action, ...(thread ? { threadId: thread.id } : {}) },
      });
      if (result._tag === "Success") {
        if (startsEnvironment) {
          const config = result.value.projects[action.projectId];
          if (config) {
            if (config.devCommand.trim()) {
              setState(result.value);
              result = await operate({
                environmentId,
                input: {
                  action: "prepare",
                  projectId: action.projectId,
                  requestId: action.requestId,
                  ...(thread ? { threadId: thread.id } : {}),
                },
              });
            }
          }
        }
      }
      if (result._tag === "Success") {
        setState(result.value);
        setError("");
      } else
        setError("Boat could not complete the action. Check capacity, budget and machine state.");
    };
    await perform().catch(() => {
      setError("Boat connection interrupted. Refresh and try again.");
    });
    setBusy(false);
  };
  const account = state?.account;
  const instances =
    state?.instances.filter((item) => !selectedProject || item.projectId === selectedProject) ?? [];
  const projectConfig = selectedProject ? state?.projects[selectedProject] : undefined;
  const isActive = (item: BoatState["instances"][number]) =>
    !["deleted", "archived", "stopped", "error"].includes(item.state);
  const projectAtCapacity =
    !!projectConfig && instances.filter(isActive).length >= projectConfig.maxConcurrent;
  const accountAtCapacity =
    !!account && (state?.instances.filter(isActive).length ?? 0) >= account.maxConcurrent;
  return (
    <SettingsSection title="Boat" id="boat">
      {error && <p role="alert">{error}</p>}
      {!state ? (
        <p role="status">Loading Boat…</p>
      ) : (
        <>
          <SettingsRow
            title="Account"
            control={
              state.configured && editable && canConnect ? (
                <Button variant="ghost" size="sm" onClick={() => setEditingKey(!editingKey)}>
                  {editingKey ? "Cancel" : "Manage key"}
                </Button>
              ) : undefined
            }
            description={
              account
                ? `${account.status} · ${account.remainingHours.toFixed(1)} base VM-hours remaining · Wallet ${dollars(account.walletUsd)}`
                : undefined
            }
          />
          {account && !account.canStart && (
            <p role="status">New machines unavailable: {account.reason ?? account.status}</p>
          )}
          {editable && canConnect && (!state.configured || editingKey) && (
            <SettingsRow title="API key">
              <form
                className="flex flex-col gap-2 sm:flex-row sm:items-center"
                onSubmit={async (event) => {
                  event.preventDefault();
                  setBusy(true);
                  try {
                    const result = await connect({
                      environmentId,
                      input: { apiKey: Redacted.make(apiKey.trim()) },
                    });
                    if (result._tag === "Success") {
                      setState(result.value);
                      setApiKey("");
                      setEditingKey(false);
                      setError("");
                    } else setError("Boat did not accept the key or could not save it.");
                  } catch {
                    setError("Boat connection interrupted. Refresh and try again.");
                  }
                  setBusy(false);
                }}
              >
                <div className="min-w-0 flex-1">
                  <Input
                    size="sm"
                    aria-label="Boat API key"
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste API key"
                  />
                </div>
                <Button type="submit" variant="outline" size="sm" disabled={busy || !apiKey.trim()}>
                  {state.configured ? "Replace key" : "Connect"}
                </Button>
                {state.configured && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const result = await disconnect({ environmentId, input: {} });
                        if (result._tag === "Success")
                          setState({ ...state, configured: false, account: null });
                        else setError("Stop running machines before disconnecting.");
                      } catch {
                        setError("Boat connection interrupted. Refresh and try again.");
                      }
                      setBusy(false);
                    }}
                  >
                    Disconnect
                  </Button>
                )}
              </form>
            </SettingsRow>
          )}
          {editable && canConfigure && (
            <BoatDefaultsForm
              key={`${state.defaults.ttlMinutes}:${state.defaults.retentionDays}`}
              defaults={state.defaults}
              busy={busy}
              save={async (defaults) => {
                setBusy(true);
                const result = await configureDefaults({ environmentId, input: defaults });
                if (result._tag === "Success") setState(result.value);
                else setError("Could not save default timeouts.");
                setBusy(false);
              }}
            />
          )}
          {projects.length > 0 && (
            <SettingsRow
              title="Project"
              control={
                <Select
                  value={selectedProject}
                  onValueChange={(value) => {
                    if (value) setProjectId(value as ProjectId);
                  }}
                >
                  <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Boat project">
                    <SelectValue>
                      {projects.find((project) => project.id === selectedProject)?.title}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              }
            />
          )}
          {selectedProject && editable && canConfigure && (
            <ProjectForm
              key={selectedProject}
              config={state.projects[selectedProject] ?? DEFAULT_BOAT_PROJECT}
              defaults={state.defaults}
              busy={busy}
              save={async (config) => {
                setBusy(true);
                try {
                  const result = await configure({
                    environmentId,
                    input: { projectId: selectedProject, config },
                  });
                  if (result._tag === "Success") {
                    setState(result.value);
                    setError("");
                  } else setError("Could not save Boat project settings.");
                } catch {
                  setError("Boat connection interrupted. Refresh and try again.");
                }
                setBusy(false);
              }}
            />
          )}
          <SettingsRow
            title="Compute used"
            description={`${dollars(instances.reduce((sum, item) => sum + item.costUsd, 0))} · ${instances.filter((item) => !["deleted", "archived", "stopped", "error"].includes(item.state)).length} active machines`}
          />
          {selectedProject && canOperate && (
            <div className="px-3 py-2 sm:px-4">
              <Button
                size="sm"
                disabled={
                  busy ||
                  !account?.canStart ||
                  !projectConfig?.enabled ||
                  projectAtCapacity ||
                  accountAtCapacity ||
                  !account.sizes.includes(projectConfig.size)
                }
                onClick={async () => {
                  const requestId = newMessageId();
                  await act({ action: "start", projectId: selectedProject, requestId });
                }}
              >
                Start environment
              </Button>
            </div>
          )}
          {instances.map((item) => (
            <div
              key={item.requestId}
              className="flex flex-col gap-2 border-t border-border px-3 py-3 text-sm sm:px-4"
            >
              <div>
                {item.size} · {item.state} · {dollars(item.costUsd)}
              </div>
              {canOperate && (
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      "prepare",
                      "preview",
                      "logs",
                      "cancel",
                      "snapshot",
                      "stop",
                      "resume",
                      "delete",
                    ] as const
                  ).map((action) => (
                    <Button
                      key={action}
                      size="sm"
                      variant="outline"
                      disabled={
                        busy ||
                        !item.sandboxId ||
                        ["deleted", "deleting"].includes(item.state) ||
                        (action === "resume" && !["archived", "stopped"].includes(item.state)) ||
                        (action === "stop" && ["archived", "stopped"].includes(item.state)) ||
                        (["prepare", "preview", "snapshot"].includes(action) &&
                          ["archived", "stopped"].includes(item.state)) ||
                        (["logs", "cancel"].includes(action) && !item.processId)
                      }
                      onClick={() =>
                        void act({ action, projectId: item.projectId, requestId: item.requestId })
                      }
                    >
                      {
                        {
                          prepare: item.processId ? "Sync changes" : "Start dev server",
                          logs: "Logs",
                          cancel: "Stop dev server",
                          snapshot: "Save snapshot",
                          preview: "Open preview",
                          stop: "Stop",
                          resume: "Resume",
                          delete: "Delete",
                        }[action]
                      }
                    </Button>
                  ))}
                </div>
              )}
              {item.output && (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">
                  {item.output}
                </pre>
              )}
              {canPreview && item.threadId && item.previewTabId && isActive(item) && (
                <div
                  role="region"
                  aria-label="Boat dev preview"
                  className="relative h-96 overflow-hidden rounded-md border border-border"
                >
                  <ServerBrowserSurface
                    environmentId={environmentId}
                    threadId={item.threadId}
                    tabId={item.previewTabId}
                    visible
                    followSize={false}
                    className="size-full"
                  />
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </SettingsSection>
  );
}

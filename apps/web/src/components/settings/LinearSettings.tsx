import {
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  ProjectId,
  ThreadId,
  type LinearAction,
  type LinearSettings,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { linearErrorMessage, linearRequest } from "../../linear/linearClient";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readEnvironmentScope } from "../../state/session";
import { useProjects, useThreadShells } from "../../state/entities";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const deliveryLabel: Record<LinearSettings["deliveries"][number]["outcome"], string> = {
  pending: "Awaiting delivery",
  delivered: "Delivered to agent",
  idle: "Waiting for an active thread",
  stopped: "Stopped or paused",
  offline: "Linear unavailable",
  revoked: "Reconnect required",
  disabled: "Disabled",
  own_reply: "Own reply ignored",
  unbound: "No matching binding",
  expired: "Expired",
  failed: "Delivery failed",
};

const setupChecklist = `Linear OAuth host setup (web/desktop)

Open this setup/copy flow in the web or desktop client. On mobile, set up the host through one of those clients.

1. Register an OAuth app you control, or ask your product app owner for a separately registered app and approved callback for this environment. For environments connected to the same Linear workspace at the same time, use separate OAuth apps. This PKCE/app-actor flow does not support independent parallel connections through one shared app for that workspace.

2. Register the exact callback URL in Linear:
<approved-base-url>/api/integrations/linear/oauth/callback

3. Set these public values in the selected T3 server's launch environment:
T3CODE_LINEAR_CLIENT_ID=<registered-public-client-id>
T3CODE_LINEAR_REDIRECT_URI=<exact-registered-callback-url>

Replace every placeholder before applying. The sign-in browser must be able to reach the callback. Use an approved HTTPS address for remote access; localhost refers to the browser's machine.
T3 uses PKCE S256, actor=app and read scope. Do not distribute personal API keys, OAuth tokens or client secrets.

4. Have the environment owner apply that startup configuration through their normal deployment procedure. Return here, Reload, Connect Linear, approve access in Linear, then Reload again.

Manual Fetch needs OAuth, not a public webhook. Optional push separately needs an approved HTTPS endpoint at /api/integrations/linear/events and a privately saved webhook signing secret.`;

export function LinearSettingsPanel() {
  const { scope, target } = useSettingsScope();
  const environmentId =
    scope.kind === "environment" && target?.environmentId === scope.environmentId
      ? scope.environmentId
      : undefined;
  const [settings, setSettings] = useState<LinearSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issueId, setIssueId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [secret, setSecret] = useState("");
  const [authorizeUrl, setAuthorizeUrl] = useState("");
  const [setupOpen, setSetupOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "Linear setup checklist",
    onError: () => setError("Could not copy the checklist. Select its text to copy it manually."),
  });
  const generation = useRef(0);
  const editable =
    environmentId !== undefined && readEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const canDeliver =
    environmentId !== undefined &&
    readEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const threads = useThreadShells(environmentId !== undefined).filter(
    (thread) =>
      thread.environmentId === environmentId &&
      thread.projectId === projectId &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  const [settingsEnvironment, setSettingsEnvironment] = useState(environmentId);
  if (settingsEnvironment !== environmentId) {
    setSettingsEnvironment(environmentId);
    setSettings(null);
    setSecret("");
    setAuthorizeUrl("");
    setSetupOpen(false);
    setIssueId("");
    setProjectId("");
    setThreadId("");
    setError("");
    setBusy(false);
  }
  useEffect(() => {
    const current = ++generation.current;
    if (environmentId)
      void linearRequest(environmentId)
        .then((result) => {
          if (current === generation.current) setSettings(result.settings);
        })
        .catch((failure: unknown) => {
          if (current === generation.current) setError(linearErrorMessage(failure));
        });
    return () => {
      if (generation.current === current) generation.current++;
    };
  }, [environmentId]);

  const run = async (action?: LinearAction) => {
    if (!environmentId || (action && !editable)) return;
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      const result = await linearRequest(environmentId, action);
      if (current !== generation.current) return;
      setSettings(result.settings);
      setSecret("");
      setAuthorizeUrl(result.authorizeUrl ?? "");
      if (result.authorizeUrl) window.open(result.authorizeUrl, "_blank", "noopener,noreferrer");
    } catch (failure) {
      if (current === generation.current) setError(linearErrorMessage(failure));
    }
    if (current === generation.current) setBusy(false);
  };
  if (!environmentId)
    return (
      <SettingsSection id="linear" title="Linear">
        <p role="status" className="px-4 py-3 text-xs text-muted-foreground">
          Select one environment to configure Linear.
        </p>
      </SettingsSection>
    );
  return (
    <SettingsSection id="linear" title="Linear">
      <SettingsRow
        title="Enable Linear"
        description={
          settings?.enabled ? "Issue delivery is limited to bound, active threads." : "Off"
        }
        control={
          <Switch
            aria-label="Enable Linear"
            checked={settings?.enabled ?? false}
            disabled={!editable || busy || !settings}
            onCheckedChange={(enabled) => void run({ type: "enable", enabled })}
          />
        }
      />
      {error ? (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {settings?.enabled ? (
        <>
          <SettingsRow
            title={settings.workspace?.name ?? "Connection"}
            description={
              settings.connection === "connected"
                ? "Connected"
                : settings.oauthConfigured
                  ? "Not connected"
                  : "Setup required: OAuth app / callback configuration is incomplete on this environment."
            }
            control={
              <div className="flex flex-wrap items-center gap-2">
                {!settings.oauthConfigured && settings.connection !== "connected" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={setupOpen}
                    aria-controls="linear-host-setup"
                    onClick={() => setSetupOpen((open) => !open)}
                  >
                    Set up Linear
                  </Button>
                ) : null}
                {authorizeUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    render={<a href={authorizeUrl} target="_blank" rel="noopener noreferrer" />}
                  >
                    Continue in Linear
                  </Button>
                ) : null}
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void run()}>
                  Reload
                </Button>
                {settings.connection === "connected" ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !editable}
                    onClick={() => void run({ type: "disconnect" })}
                  >
                    Disconnect
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={busy || !editable || !settings.oauthConfigured}
                    onClick={() => void run({ type: "connect" })}
                  >
                    Connect Linear
                  </Button>
                )}
              </div>
            }
          />
          {setupOpen && !settings.oauthConfigured ? (
            <div
              id="linear-host-setup"
              role="region"
              aria-label="Linear host setup"
              className="flex flex-col gap-3 border-t border-border/50 px-4 py-3"
            >
              <pre className="whitespace-pre-wrap break-words text-xs">{setupChecklist}</pre>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => copyToClipboard(setupChecklist)}>
                  {isCopied ? "Copied" : "Copy setup checklist"}
                </Button>
                <Button
                  size="sm"
                  variant="link"
                  render={
                    <a
                      href="https://linear.app/developers/oauth-2-0-authentication"
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                >
                  Linear OAuth guide
                </Button>
              </div>
            </div>
          ) : null}
          {settings.connection === "connected" ? (
            <>
              <div className="flex flex-col gap-3 border-t border-border/50 px-4 py-3">
                <Input
                  aria-label="Linear issue"
                  placeholder="Issue identifier, e.g. WEA-14"
                  value={issueId}
                  onChange={(event) => setIssueId(event.target.value)}
                  disabled={!editable || busy}
                />
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={projectId}
                    onValueChange={(value) => {
                      setProjectId(value ?? "");
                      setThreadId("");
                    }}
                  >
                    <SelectTrigger aria-label="T3 project" disabled={!editable || busy}>
                      <SelectValue placeholder="Project" />
                    </SelectTrigger>
                    <SelectPopup>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Select value={threadId} onValueChange={(value) => setThreadId(value ?? "")}>
                    <SelectTrigger
                      aria-label="Existing thread"
                      disabled={!editable || busy || !projectId}
                    >
                      <SelectValue placeholder="Existing thread" />
                    </SelectTrigger>
                    <SelectPopup>
                      {threads.map((thread) => (
                        <SelectItem key={thread.id} value={thread.id}>
                          {thread.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <Button
                    size="sm"
                    disabled={
                      !editable || !canDeliver || busy || !issueId.trim() || !projectId || !threadId
                    }
                    onClick={() =>
                      void run({
                        type: "bind",
                        issueId: issueId.trim(),
                        projectId: ProjectId.make(projectId),
                        threadId: ThreadId.make(threadId),
                      })
                    }
                  >
                    Bind issue
                  </Button>
                </div>
              </div>
              {settings.bindings.map((binding) => (
                <SettingsRow
                  key={binding.id}
                  title={`${binding.identifier} · ${binding.title}`}
                  description={
                    threads.find((thread) => thread.id === binding.threadId)?.title ??
                    "Existing thread"
                  }
                  control={
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!editable || !canDeliver || busy}
                        onClick={() => void run({ type: "sync", bindingId: binding.id })}
                      >
                        Fetch issue
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!editable || busy}
                        onClick={() => void run({ type: "unbind", bindingId: binding.id })}
                      >
                        Remove
                      </Button>
                    </div>
                  }
                />
              ))}
              <SettingsRow
                title="Webhook signing secret"
                description={
                  settings.webhookConfigured
                    ? "Saved privately on this environment"
                    : "Optional; requires a separately configured HTTPS ingress"
                }
                control={
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      aria-label="Linear webhook signing secret"
                      value={secret}
                      onChange={(event) => setSecret(event.target.value)}
                      disabled={!editable || busy}
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!editable || busy || !secret.trim()}
                      onClick={() => void run({ type: "webhook-secret", secret })}
                    >
                      Save secret
                    </Button>
                  </div>
                }
              />
              {settings.deliveries
                .slice(-5)
                .toReversed()
                .map((delivery) => (
                  <SettingsRow
                    key={delivery.id}
                    title={deliveryLabel[delivery.outcome]}
                    description={
                      settings.bindings.find((binding) => binding.id === delivery.bindingId)
                        ?.identifier
                    }
                    control={
                      ["idle", "offline", "disabled", "stopped", "revoked", "failed"].includes(
                        delivery.outcome,
                      ) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!editable || !canDeliver || busy}
                          onClick={() => void run({ type: "retry", deliveryId: delivery.id })}
                        >
                          Retry delivery
                        </Button>
                      ) : null
                    }
                  />
                ))}
            </>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

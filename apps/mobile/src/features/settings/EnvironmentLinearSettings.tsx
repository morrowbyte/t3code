import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  LinearIntegrationError,
  type EnvironmentId,
  type LinearAction,
  type LinearActionResult,
  type LinearSettings,
} from "@t3tools/contracts";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import { requestEnvironmentLinear } from "@t3tools/client-runtime/state/linear";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AtomRegistry } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { Menu } from "../../components/ui/Menu";
import { AppText as Text } from "../../components/ui/AppText";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { useProjects, useThreadShells } from "../../state/entities";
import { environmentSession, readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

async function linearRequest(environmentId: EnvironmentId, action?: LinearAction) {
  const required = action ? AuthSettingsWriteScope : AuthOrchestrationReadScope;
  if (
    !readEnvironmentScope(environmentId, required) ||
    (action?.type === "bind" && !readEnvironmentScope(environmentId, AuthOrchestrationReadScope)) ||
    ((action?.type === "sync" || action?.type === "retry") &&
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
  ) {
    throw new LinearIntegrationError({ reason: "target_unavailable" });
  }
  const request = connectionAtomRuntime.fn<void>()((_input, get) =>
    Effect.gen(function* () {
      const prepared = get(environmentSession.preparedConnectionValueAtom(environmentId));
      if (Option.isNone(prepared) || prepared.value.environmentId !== environmentId)
        return yield* new LinearIntegrationError({ reason: "offline" });
      return yield* requestEnvironmentLinear({
        prepared: prepared.value,
        signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
        remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
        ...(action ? { action } : {}),
      });
    }).pipe(Effect.withTracerEnabled(false)),
  );
  appAtomRegistry.set(request, undefined);
  const result = await Effect.runPromise(
    Effect.result(AtomRegistry.getResult(appAtomRegistry, request, { suspendOnWaiting: true })),
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

interface PanelProps {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canOperate: boolean;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly request: (
    environmentId: EnvironmentId,
    action?: LinearAction,
  ) => Promise<typeof LinearActionResult.Type>;
  readonly openUrl: (url: string) => Promise<unknown>;
}

export function EnvironmentLinearSettingsPanel(props: PanelProps) {
  const [opened, setOpened] = useState(false);
  const [settings, setSettings] = useState<LinearSettings | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [issueId, setIssueId] = useState("");
  const generation = useRef(0);
  const inFlight = useRef(false);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  const projects = props.projects.filter(
    (project) => project.environmentId === props.environmentId,
  );
  const project = projects.find((entry) => entry.id === projectId);
  const threads = props.threads.filter(
    (thread) =>
      thread.environmentId === props.environmentId &&
      thread.projectId === project?.id &&
      thread.archivedAt === null &&
      thread.deletedAt === null,
  );
  const thread = threads.find((entry) => entry.id === threadId);
  const readable = props.connected && props.canRead;
  const editable = readable && props.canWrite;

  async function run(action?: LinearAction) {
    if (
      inFlight.current ||
      !readable ||
      (action && !editable) ||
      ((action?.type === "retry" || action?.type === "sync") && !props.canOperate)
    )
      return;
    const current = generation.current;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await props.request(props.environmentId, action);
      if (generation.current !== current) return;
      if (result.settings.environmentId !== props.environmentId) {
        throw new LinearIntegrationError({ reason: "target_unavailable" });
      }
      setSettings(result.settings);
      setAuthorizeUrl(result.authorizeUrl ?? null);
      if (result.authorizeUrl) await props.openUrl(result.authorizeUrl);
    } catch (cause) {
      if (generation.current === current)
        setError(cause instanceof Error ? cause.message : "Could not update Linear. Try again.");
    } finally {
      if (generation.current === current) {
        inFlight.current = false;
        setPending(false);
      }
    }
  }

  if (!opened)
    return (
      <SettingsSection title="Linear">
        <SettingsActionRow
          icon="link"
          label="Open Linear settings"
          disabled={!readable}
          onPress={() => {
            setOpened(true);
            void run();
          }}
        />
      </SettingsSection>
    );
  const busy = pending || !editable;
  return (
    <SettingsSection title="Linear">
      {settings ? (
        <SettingsSwitchRow
          label="Enable Linear"
          value={settings.enabled}
          disabled={busy}
          onValueChange={(enabled) => void run({ type: "enable", enabled })}
        />
      ) : null}
      {error ? (
        <Text accessibilityLiveRegion="polite" className="px-4 py-3 text-sm text-danger-foreground">
          {error}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Reload Linear"
        loading={pending}
        disabled={!readable}
        onPress={() => void run()}
      />
      {settings?.enabled ? (
        <>
          <Text className="px-4 py-2 text-sm text-foreground-muted">
            {settings.workspace?.name ??
              (settings.connection === "revoked" ? "Connection revoked" : "Not connected")}
          </Text>
          {!settings.oauthConfigured ? (
            <Text className="px-4 py-2 text-sm text-foreground-muted">
              A Linear OAuth app is not configured on this host.
            </Text>
          ) : null}
          <SettingsActionRow
            icon="link"
            label={settings.connection === "connected" ? "Disconnect Linear" : "Connect Linear"}
            disabled={busy || (!settings.oauthConfigured && settings.connection !== "connected")}
            onPress={() =>
              void run({ type: settings.connection === "connected" ? "disconnect" : "connect" })
            }
          />
          {authorizeUrl ? (
            <SettingsActionRow
              icon="globe"
              label="Continue in Linear"
              disabled={pending || !readable}
              onPress={() => {
                void props.openUrl(authorizeUrl).catch(() => setError("Could not open Linear."));
              }}
            />
          ) : null}
          {settings.connection === "connected" ? (
            <>
              <Menu
                actions={projects.map((entry) => ({ id: entry.id, title: entry.title }))}
                onPressAction={({ nativeEvent }) => {
                  setProjectId(nativeEvent.event);
                  setThreadId(null);
                }}
              >
                <SettingsActionRow
                  label="Project"
                  detail={project?.title ?? "Choose project"}
                  disabled={busy || projects.length === 0}
                  onPress={() => {}}
                />
              </Menu>
              <Menu
                actions={threads.map((entry) => ({ id: entry.id, title: entry.title }))}
                onPressAction={({ nativeEvent }) => setThreadId(nativeEvent.event)}
              >
                <SettingsActionRow
                  label="Thread"
                  detail={thread?.title ?? "Choose thread"}
                  disabled={busy || threads.length === 0}
                  onPress={() => {}}
                />
              </Menu>
              <TextInput
                accessibilityLabel="Linear issue ID or identifier"
                placeholder="Issue ID or identifier"
                value={issueId}
                onChangeText={setIssueId}
                editable={!busy}
                autoCapitalize="none"
                className="mx-4 min-h-12 rounded-lg border border-border px-3 text-base text-foreground"
              />
              <SettingsActionRow
                icon="link"
                label="Bind issue"
                disabled={busy || !project || !thread || !issueId.trim()}
                onPress={() => {
                  if (project && thread)
                    void run({
                      type: "bind",
                      issueId: issueId.trim(),
                      projectId: project.id,
                      threadId: thread.id,
                    });
                }}
              />
              {settings.bindings.map((binding) => (
                <View key={binding.id}>
                  <Text className="px-4 pt-3 text-base text-foreground">
                    {binding.identifier} · {binding.title}
                  </Text>
                  <Text className="px-4 py-1 text-sm text-foreground-muted">
                    {props.threads.find(
                      (entry) =>
                        entry.environmentId === props.environmentId &&
                        entry.id === binding.threadId,
                    )?.title ?? binding.threadId}
                  </Text>
                  <SettingsActionRow
                    label={`Unbind ${binding.identifier}`}
                    disabled={busy}
                    onPress={() => void run({ type: "unbind", bindingId: binding.id })}
                  />
                </View>
              ))}
              {settings.deliveries
                .slice(-5)
                .reverse()
                .filter((delivery) =>
                  ["idle", "offline", "disabled", "stopped", "revoked", "failed"].includes(
                    delivery.outcome,
                  ),
                )
                .map((delivery) => (
                  <SettingsActionRow
                    key={delivery.id}
                    icon="arrow.clockwise"
                    label="Retry delivery"
                    detail={delivery.outcome}
                    disabled={busy || !props.canOperate}
                    onPress={() => void run({ type: "retry", deliveryId: delivery.id })}
                  />
                ))}
            </>
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

export function EnvironmentLinearSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
}) {
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const projects = useProjects();
  const threads = useThreadShells();
  return (
    <EnvironmentLinearSettingsPanel
      key={props.environmentId}
      {...props}
      canRead={canRead}
      canWrite={canWrite}
      canOperate={canOperate}
      projects={projects}
      threads={threads}
      request={linearRequest}
      openUrl={Linking.openURL}
    />
  );
}

import { StackActions, useNavigation } from "@react-navigation/native";
import * as Cause from "effect/Cause";
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BOAT_PROJECT,
  AuthPreviewOperateScope,
  type BoatAction,
  type BoatDefaults,
  type BoatState,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useEffect, useState } from "react";
import { Modal, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { uuidv4 } from "../../lib/uuid";
import { boatEnvironment as boat } from "../../state/boat";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { useProjects, useThreadShells } from "../../state/entities";
import { NumberField } from "../../components/ui/NumberField";
import { AppText } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function EnvironmentBoatSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const [state, setState] = useState<BoatState | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const read = useAtomCommand(boat.read);
  const connect = useAtomCommand(boat.connect);
  const disconnect = useAtomCommand(boat.disconnect);
  const configureDefaults = useAtomCommand(boat.defaults);
  const configure = useAtomCommand(boat.configure);
  const operate = useAtomCommand(boat.operate);
  const setup = useAtomCommand(boat.setup, { reportFailure: false });
  const canSetup = useAtomValue(boat.setup.permissionAtom(environmentId));
  const navigation = useNavigation();
  const canConfigure = useAtomValue(boat.configure.permissionAtom(environmentId));
  const canOperate = useAtomValue(boat.operate.permissionAtom(environmentId));
  const canConnect = useAtomValue(boat.connect.permissionAtom(environmentId));
  const threads = useThreadShells();
  const canPreview = useEnvironmentScope(environmentId, AuthPreviewOperateScope);
  const projects = useProjects().filter((item) => item.environmentId === environmentId);
  const refresh = async () => {
    const result = await read({ environmentId, input: {} });
    if (result._tag === "Success") setState(result.value);
  };
  const act = async (input: BoatAction) => {
    const startsEnvironment = input.action === "start" || input.action === "resume";
    setBusy(true);
    const perform = async () => {
      const thread = canPreview
        ? threads.find(
            (item) => item.environmentId === environmentId && item.projectId === input.projectId,
          )
        : undefined;
      let result = await operate({
        environmentId,
        input: { ...input, ...(thread ? { threadId: thread.id } : {}) },
      });
      if (result._tag === "Success") {
        if (startsEnvironment) {
          const config = result.value.projects[input.projectId];
          if (config) {
            if (config.devCommand.trim()) {
              setState(result.value);
              result = await operate({
                environmentId,
                input: {
                  action: "prepare",
                  projectId: input.projectId,
                  requestId: input.requestId,
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
      } else setError("Could not complete Boat action. Check capacity, budget and machine state.");
    };
    await perform().catch(() => {
      setError("Boat connection interrupted. Refresh and try again.");
    });
    setBusy(false);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Subscribe this screen to the external account state.
  useEffect(() => {
    let active = true;
    let pending = false;
    const update = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await read({ environmentId, input: {} });
        if (active) {
          if (result._tag === "Success") setState(result.value);
        }
      } catch {
        setError("Boat connection interrupted. Refresh and try again.");
      }
      pending = false;
    };
    void update();
    const timer = setInterval(() => void update(), 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [environmentId, read]);
  return (
    <SettingsSection title="Boat">
      <Modal
        visible={previewUrl !== null}
        onRequestClose={() => setPreviewUrl(null)}
        animationType="slide"
      >
        <SafeAreaView className="flex-1 bg-background">
          <ListActionRow label="Close preview" onPress={() => setPreviewUrl(null)} />
          {previewUrl !== null && (
            <WebView
              source={{ uri: previewUrl }}
              style={{ flex: 1 }}
              allowsFullscreenVideo
              setSupportMultipleWindows={false}
            />
          )}
        </SafeAreaView>
      </Modal>
      <ListActionRow
        label={state?.configured ? "Connected" : "Connect account"}
        description={
          state?.account
            ? `${state.account.remainingHours.toFixed(1)} h remaining · $${state.account.walletUsd.toFixed(2)} wallet`
            : undefined
        }
        onPress={() => void refresh()}
      />
      {error ? <AppText>{error}</AppText> : null}
      {canConnect && (
        <View className="gap-2 px-4 py-2">
          <TextInput
            accessibilityLabel="Boat API key"
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            value={key}
            onChangeText={setKey}
            placeholder="boat_…"
            className="rounded-lg border border-border p-3 text-foreground"
          />
          <ListActionRow
            label="Save key"
            disabled={busy || !key.trim()}
            onPress={async () => {
              setBusy(true);
              try {
                const result = await connect({
                  environmentId,
                  input: { apiKey: Redacted.make(key.trim()) },
                });
                if (result._tag === "Success") {
                  setState(result.value);
                  setKey("");
                  setError("");
                } else setError("Could not connect Boat.");
              } catch {
                setError("Boat connection interrupted. Refresh and try again.");
              }
              setBusy(false);
            }}
          />
        </View>
      )}
      {state?.configured && canConnect && (
        <ListActionRow
          label="Disconnect Boat"
          disabled={busy}
          onPress={async () => {
            const result = await disconnect({ environmentId, input: {} });
            if (result._tag === "Success") await refresh();
            else setError("Stop running machines before disconnecting.");
          }}
        />
      )}
      {state && canConfigure && (
        <DefaultLimits
          key={`${state.defaults.ttlMinutes}:${state.defaults.retentionDays}`}
          value={state.defaults}
          busy={busy}
          save={async (input) => {
            const result = await configureDefaults({ environmentId, input });
            if (result._tag === "Success") setState(result.value);
          }}
        />
      )}
      {projects.map((project) => {
        const config = state?.projects[project.id] ?? DEFAULT_BOAT_PROJECT;
        return (
          <View key={project.id}>
            {config.enabled && canSetup && (
              <ListActionRow
                label="Open setup agent"
                disabled={busy}
                onPress={async () => {
                  setBusy(true);
                  try {
                    const result = await setup({ environmentId, input: { projectId: project.id } });
                    if (result._tag === "Success")
                      navigation.dispatch(
                        StackActions.push("Thread", {
                          environmentId,
                          threadId: result.value.threadId,
                        }),
                      );
                    else {
                      const failure = Cause.squash(result.cause);
                      if (failure instanceof Error) setError(failure.message);
                      else setError("Could not resume Boat setup.");
                    }
                  } catch {
                    setError("Boat connection interrupted. Refresh and try again.");
                  }
                  setBusy(false);
                }}
              />
            )}
            <ListActionRow
              label={project.title}
              description={config.enabled ? `Boat · ${config.size}` : "Local"}
              disabled={!canConfigure || busy}
              onPress={async () => {
                const result = await configure({
                  environmentId,
                  input: { projectId: project.id, config: { ...config, enabled: !config.enabled } },
                });
                if (result._tag === "Success") setState(result.value);
              }}
            />
            {config.enabled && (
              <>
                <ListActionRow
                  label={`Preview: ${config.previewKind === "android" ? "Android emulator" : "Web"}`}
                  disabled={busy || !canConfigure}
                  onPress={async () => {
                    const result = await configure({
                      environmentId,
                      input: {
                        projectId: project.id,
                        config: {
                          ...config,
                          previewKind: config.previewKind === "android" ? "web" : "android",
                        },
                      },
                    });
                    if (result._tag === "Success") setState(result.value);
                  }}
                />
                <ListActionRow
                  label={`CI/CD: ${config.ciEnabled ? "On" : "Off"}`}
                  disabled={busy || !canConfigure}
                  onPress={async () => {
                    const result = await configure({
                      environmentId,
                      input: {
                        projectId: project.id,
                        config: { ...config, ciEnabled: !config.ciEnabled },
                      },
                    });
                    if (result._tag === "Success") setState(result.value);
                  }}
                />
              </>
            )}
            {config.enabled && (
              <ListActionRow
                label={`Start ${config.size} environment`}
                disabled={
                  busy ||
                  !canOperate ||
                  !state?.account?.canStart ||
                  state.instances.filter(
                    (item) =>
                      item.projectId === project.id &&
                      !["deleted", "archived", "stopped", "error"].includes(item.state),
                  ).length >= config.maxConcurrent
                }
                onPress={() =>
                  void act({ action: "start", projectId: project.id, requestId: uuidv4() })
                }
              />
            )}
          </View>
        );
      })}
      {state?.instances.map((instance) => (
        <View key={instance.requestId}>
          <AppText>{`${instance.size} · ${instance.state} · $${instance.costUsd.toFixed(3)}`}</AppText>
          {instance.savedSnapshot && (
            <AppText>{`Snapshot ${instance.savedSnapshot.name} · ${{ saving: "Saving…", ready: "Ready", failed: "Save failed" }[instance.savedSnapshot.status]}`}</AppText>
          )}
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
            <ListActionRow
              key={action}
              label={
                {
                  prepare: instance.processId ? "Sync changes" : "Start dev server",
                  preview: "Open preview",
                  logs: "Logs",
                  cancel: "Stop dev server",
                  snapshot: "Save snapshot",
                  stop: "Stop",
                  resume: "Resume",
                  delete: "Delete",
                }[action]
              }
              disabled={
                !canOperate ||
                busy ||
                !instance.sandboxId ||
                (action === "snapshot" &&
                  state.instances.some(
                    (entry) =>
                      entry.projectId === instance.projectId &&
                      entry.savedSnapshot?.status === "saving",
                  )) ||
                ["deleted", "deleting"].includes(instance.state) ||
                (action === "resume" && !["archived", "stopped"].includes(instance.state)) ||
                (["prepare", "preview", "snapshot", "stop"].includes(action) &&
                  ["archived", "stopped"].includes(instance.state)) ||
                (["logs", "cancel"].includes(action) && !instance.processId)
              }
              onPress={() =>
                void act({ action, projectId: instance.projectId, requestId: instance.requestId })
              }
            />
          ))}
          {instance.output ? <AppText>{instance.output}</AppText> : null}
          {instance.previewUrl && (
            <ListActionRow
              label="Open preview"
              onPress={() => setPreviewUrl(instance.previewUrl)}
            />
          )}
        </View>
      ))}
    </SettingsSection>
  );
}

function DefaultLimits({
  value,
  busy,
  save,
}: {
  value: BoatDefaults;
  busy: boolean;
  save: (value: BoatDefaults) => void;
}) {
  const [draft, setDraft] = useState(value);
  return (
    <View className="gap-3 px-4 py-3">
      <View className="flex-row items-center justify-between gap-3">
        <AppText>Auto-stop (minutes)</AppText>
        <NumberField
          label="Auto-stop minutes"
          min={1}
          max={1440}
          value={draft.ttlMinutes}
          onValueChange={(ttlMinutes) => setDraft({ ...draft, ttlMinutes })}
          disabled={busy}
        />
      </View>
      <View className="flex-row items-center justify-between gap-3">
        <AppText>Keep stopped disk (days)</AppText>
        <NumberField
          label="Keep stopped disk days"
          min={0}
          max={14}
          value={draft.retentionDays}
          onValueChange={(retentionDays) => setDraft({ ...draft, retentionDays })}
          disabled={busy}
        />
      </View>
      <ListActionRow label="Save limits" disabled={busy} onPress={() => save(draft)} />
    </View>
  );
}

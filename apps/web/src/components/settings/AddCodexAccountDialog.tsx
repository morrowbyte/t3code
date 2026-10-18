import { AuthProvidersManageScope } from "@t3tools/contracts";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { usesChatGptSharing } from "@t3tools/shared/usageLimits";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { Input } from "../ui/input";
import { Radio, RadioGroup } from "../ui/radio-group";
import { WizardFooter, WizardHeader, WizardPanel, WizardPopup } from "../ui/wizard";
import { SettingsRow } from "./settingsLayout";

export function AddCodexAccountDialog({
  environmentId,
  onClose,
  renderSetup,
  onAccountCreated,
}: {
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onAccountCreated?:
    | ((instanceId: ProviderInstanceId, displayName: string, mode: "existing" | "managed") => void)
    | undefined;
  readonly renderSetup: (
    instanceId: ProviderInstanceId,
    provider: ServerProvider,
    mode: "existing" | "managed",
  ) => ReactNode;
}) {
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const settings = useEnvironmentSettings(environmentId);
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, "Add ChatGPT account");
  const [name, setName] = useState("Personal");
  const displayName = `ChatGPT - ${name.trim()}`;
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const [mode, setMode] = useState<"existing" | "managed">("existing");
  const provider = providers?.find((candidate) => candidate.instanceId === instanceId);
  const connected =
    mode === "managed"
      ? usesChatGptSharing(provider)
      : provider?.driver === "codex" &&
        provider.auth.status === "authenticated" &&
        provider.auth.type === "chatgpt" &&
        provider.auth.subscriptionSharing !== true;
  const closeAfterConnection = useEffectEvent(onClose);
  useEffect(() => {
    if (connected) closeAfterConnection();
  }, [connected]);

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    // The ID is routing identity; the name is editable and need not be unique.
    const id = ProviderInstanceId.make(`codex_${randomUUID()}`);
    const result = await update({
      environmentId,
      input: {
        patch: {
          providerInstances: {
            ...settings.providerInstances,
            [id]: {
              driver: ProviderDriverKind.make("codex"),
              displayName,
              enabled: true,
              config: {
                enabled: true,
                setupMode: mode,
                ...(mode === "existing" ? { homePath: `~/.codex-t3/${id}` } : {}),
              },
            },
          },
        },
      },
    });
    if (result._tag === "Success") {
      if (onAccountCreated) {
        onAccountCreated(id, displayName, mode);
        onClose();
      } else {
        setInstanceId(id);
      }
    }
    setPending(false);
  };

  return (
    <Dialog
      open={!connected}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <WizardPopup size="wide">
        <WizardHeader title={instanceId ? displayName : "Add ChatGPT account"} />
        <WizardPanel>
          {instanceId ? (
            provider?.setup ? (
              renderSetup(instanceId, provider, mode)
            ) : (
              <SettingsRow title="Codex runtime" description="Preparing account setup." />
            )
          ) : (
            <form
              id="add-codex-account"
              onSubmit={(event) => {
                event.preventDefault();
                void createAccount();
              }}
            >
              <SettingsRow
                title="Sign-in route"
                control={
                  <RadioGroup
                    aria-label="Sign-in route"
                    value={mode}
                    disabled={pending}
                    onValueChange={(value) => {
                      if (value === "existing" || value === "managed") setMode(value);
                    }}
                  >
                    <label className="flex items-center gap-2">
                      <Radio value="existing" />
                      Codex ChatGPT login (recommended)
                    </label>
                    <label className="flex items-center gap-2">
                      <Radio value="managed" />
                      Token sharing (limited text and tools)
                    </label>
                  </RadioGroup>
                }
              />
              <SettingsRow
                title="Account name"
                description="Shown in the provider list and model picker."
                control={
                  <Input
                    aria-label="Account name"
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="e.g. Personal or Work"
                  />
                }
              />
            </form>
          )}
        </WizardPanel>
        <WizardFooter>
          {instanceId ? (
            <Button variant="outline" onClick={onClose}>
              Finish later
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={pending} onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                form="add-codex-account"
                disabled={pending || !name.trim() || !canManageProviders}
              >
                {pending ? "Adding account…" : "Continue"}
              </Button>
            </>
          )}
        </WizardFooter>
      </WizardPopup>
    </Dialog>
  );
}

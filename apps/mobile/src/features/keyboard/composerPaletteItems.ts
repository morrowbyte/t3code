import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import type { ModelOption } from "../../lib/modelOptions";
import { applyProviderOptionSelection } from "../../lib/providerOptions";
import {
  runtimeModeChoicesForSupportedModes,
  selectableChoices,
} from "../threads/thread-settings-options";
import type { CommandPaletteItem } from "./commandPaletteItems";

function group(
  key: string,
  title: string,
  detail: string | undefined,
  children: ReadonlyArray<CommandPaletteItem>,
  searchTerms: ReadonlyArray<string> = [],
): CommandPaletteItem {
  return { key, title, detail, kind: "action", searchTerms, children, run: () => {} };
}

export function composerPaletteItems(input: {
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection;
  readonly reportedModelSelection?: ModelSelection | null;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  readonly canConfigure: boolean;
  readonly supportsFiles: boolean;
  readonly onSelectModel: (option: ModelOption) => void;
  readonly onUpdateOptionSelections: (options: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly onPickMedia: () => void;
  readonly onPickFiles: () => void;
}): ReadonlyArray<CommandPaletteItem> {
  const actions: CommandPaletteItem[] = [];
  if (input.canConfigure) {
    const selectedModel = input.modelOptions.find(
      (option) =>
        option.selection.instanceId === input.selectedModel.instanceId &&
        option.selection.model === input.selectedModel.model,
    );
    const models = input.modelOptions.filter((option) => !option.isHidden && !option.isUnavailable);
    actions.push(
      group(
        "composer.model",
        "Model",
        selectedModel?.label ?? input.selectedModel.model,
        models.map((option) => ({
          key: `composer.model.${option.key}`,
          title: option.label,
          kind: "action",
          detail: `${option.providerLabel}${option.key === selectedModel?.key ? " · Selected" : ""}`,
          searchTerms: [option.selection.model, option.providerLabel, option.subtitle],
          run: () => input.onSelectModel(option),
        })),
        ["provider", "model", "agent"],
      ),
    );
    for (const descriptor of input.optionDescriptors) {
      const current = getProviderOptionCurrentValue(
        descriptor,
        input.selectedModel,
        input.reportedModelSelection,
      );
      const choices =
        descriptor.type === "boolean"
          ? [
              { id: "on", label: "On", value: true },
              { id: "off", label: "Off", value: false },
            ]
          : selectableChoices(descriptor).map((option) => ({ ...option, value: option.id }));
      actions.push(
        group(
          `composer.option.${descriptor.id}`,
          descriptor.label,
          getProviderOptionCurrentLabel(
            descriptor,
            input.selectedModel,
            input.reportedModelSelection,
          ),
          choices.map((choice) => ({
            key: `composer.option.${descriptor.id}.${choice.id}`,
            title: choice.label,
            kind: "action",
            detail: current === choice.value ? "Selected" : undefined,
            searchTerms: [descriptor.label, descriptor.id, choice.id],
            run: () => {
              const options = applyProviderOptionSelection(input.optionDescriptors, {
                id: descriptor.id,
                value: choice.value,
              });
              if (options) input.onUpdateOptionSelections(options);
            },
          })),
          [descriptor.id, descriptor.label],
        ),
      );
    }
    const accessChoices = runtimeModeChoicesForSupportedModes(selectedModel?.supportedRuntimeModes);
    actions.push(
      group(
        "composer.access",
        "Access",
        accessChoices.find((choice) => choice.mode === input.runtimeMode)?.label,
        accessChoices.map((choice) => ({
          key: `composer.access.${choice.mode}`,
          title: choice.label,
          detail: choice.mode === input.runtimeMode ? "Selected" : choice.description,
          kind: "action",
          searchTerms: [choice.mode, choice.description],
          run: () => input.onUpdateRuntimeMode(choice.mode),
        })),
        ["permissions", "approval", "runtime"],
      ),
    );
  }
  actions.push({
    key: "composer.attachMedia",
    kind: "action",
    title: "Attach photos or videos",
    searchTerms: ["attachment", "photo library", "image"],
    run: input.onPickMedia,
  });
  if (input.supportsFiles)
    actions.push({
      key: "composer.attachFiles",
      kind: "action",
      title: "Attach files from this device",
      searchTerms: ["attachment", "document", "file picker", "upload"],
      run: input.onPickFiles,
    });
  return actions;
}

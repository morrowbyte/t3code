import { describe, expect, it, vi } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";
import { composerPaletteItems } from "./composerPaletteItems";

const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "current",
};
const model = (id: string, extra: Partial<ModelOption> = {}): ModelOption => ({
  key: id,
  label: id,
  subtitle: "",
  providerKey: "codex",
  providerLabel: "Codex",
  providerDriver: "codex",
  isDefault: false,
  isLegacy: false,
  capabilities: null,
  selection: { ...selection, model: id },
  ...extra,
});
const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    currentValue: "high",
    promptInjectedValues: ["ultrathink"],
    options: [
      { id: "high", label: "High" },
      { id: "ultra", label: "Ultra" },
      { id: "ultrathink", label: "Ultrathink" },
    ],
  },
  {
    id: "serviceTier",
    label: "Service tier",
    type: "select",
    currentValue: "default",
    options: [
      { id: "default", label: "Standard" },
      { id: "fast", label: "Fast" },
    ],
  },
];
const base = () => ({
  modelOptions: [
    model("current", { supportedRuntimeModes: ["approval-required", "full-access"] }),
    model("available"),
    model("hidden", { isHidden: true }),
    model("unavailable", { isUnavailable: true }),
  ],
  selectedModel: selection,
  optionDescriptors: descriptors,
  runtimeMode: "approval-required" as const,
  canConfigure: true,
  supportsFiles: true,
  onSelectModel: vi.fn(),
  onUpdateOptionSelections: vi.fn(),
  onUpdateRuntimeMode: vi.fn(),
  onFocus: vi.fn(),
  onPickMedia: vi.fn(),
  onPickFiles: vi.fn(),
});

describe("composer keyboard choices", () => {
  it("keeps provider capability constraints when changing settings from the palette", () => {
    const input = base();
    const actions = composerPaletteItems(input);
    expect(
      actions.find((item) => item.key === "composer.model")?.children?.map((item) => item.title),
    ).toEqual(["current", "available"]);
    const reasoning = actions.find((item) => item.key === "composer.option.reasoningEffort")!;
    expect(reasoning.detail).toBe("High");
    expect(reasoning.children?.map((item) => item.title)).toEqual(["High", "Ultra"]);
    reasoning.children?.find((item) => item.title === "Ultra")?.run();
    expect(input.onUpdateOptionSelections).toHaveBeenCalledWith([
      { id: "reasoningEffort", value: "ultra" },
      { id: "serviceTier", value: "default" },
    ]);
    expect(
      actions.find((item) => item.key === "composer.access")?.children?.map((item) => item.title),
    ).toEqual(["Supervised", "Full access"]);
  });

  it("only offers permitted controls and supported attachment sources", () => {
    const actions = composerPaletteItems({ ...base(), canConfigure: false, supportsFiles: false });
    expect(actions.map((item) => item.key)).toEqual(["composer.attachMedia"]);
  });

  it("shows reported values without turning other reported settings into explicit overrides", () => {
    const input = {
      ...base(),
      selectedModel: { ...selection, options: [{ id: "reasoningEffort", value: "high" }] },
      reportedModelSelection: { ...selection, options: [{ id: "serviceTier", value: "fast" }] },
    };
    const actions = composerPaletteItems(input);
    expect(actions.find((item) => item.key === "composer.option.serviceTier")?.detail).toBe("Fast");
    actions
      .find((item) => item.key === "composer.option.reasoningEffort")
      ?.children?.find((item) => item.title === "Ultra")
      ?.run();
    expect(input.onUpdateOptionSelections).toHaveBeenCalledWith([
      { id: "reasoningEffort", value: "ultra" },
      { id: "serviceTier", value: "default" },
    ]);
  });
});

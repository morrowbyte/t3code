import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { useState, type ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  requestNavigationMode,
  leaveNavigationMode,
  isNavigationMode,
} from "../keyboard/navigationMode";

vi.mock(import("./ModelPickerContent"), async (original) => {
  const actual = await original();
  const { memo } = await import("react");
  return {
    ...actual,
    ModelPickerContent: memo<typeof actual.ModelPickerContent.type>(
      (props: ComponentProps<typeof actual.ModelPickerContent>) => (
        <button
          autoFocus
          onClick={() => props.onInstanceModelChange(props.activeInstanceId, "test-model")}
        >
          Choose current model
        </button>
      ),
    ),
  };
});
import { ProviderModelPicker } from "./ProviderModelPicker";
import { render } from "../../../test/render";

it.each([true, false])(
  "restores keyboard NAV only for keyboard-originated model selection: %s",
  async (keyboard) => {
    using resources = new DisposableStack();
    resources.defer(leaveNavigationMode);
    const target = document.body.appendChild(document.createElement("button"));
    resources.defer(() => target.remove());
    target.textContent = "Navigation target";
    const draft = document.body.appendChild(document.createElement("textarea"));
    resources.defer(() => draft.remove());
    draft.value = "Unchanged draft";
    const focusComposer = vi.fn(() => {
      draft.focus();
      leaveNavigationMode();
    });
    const unexpected = (): never => {
      throw new Error("Unexpected composer operation in focus test");
    };
    const composer: ComposerHandleRef = {
      current: {
        focusAtEnd: focusComposer,
        focusAt: unexpected,
        restoreAfterTimelineReachedEnd: unexpected,
        collapseForTimelineScrollKey: unexpected,
        addDroppedFiles: unexpected,
        addDroppedFolders: unexpected,
        hasPendingAttachments: unexpected,
        insertTextAtEnd: unexpected,
        pasteTextAtEnd: unexpected,
        citeAssistantText: unexpected,
        openModelPicker: unexpected,
        stepReasoningEffort: unexpected,
        toggleModelPicker: unexpected,
        openControl: unexpected,
        isModelPickerOpen: unexpected,
        isCaretAtStart: unexpected,
        compactContext: unexpected,
        readSnapshot: unexpected,
        resetCursorState: unexpected,
        addTerminalContext: unexpected,
        getSendContext: unexpected,
        validateProviderInput: unexpected,
        setMultipleModelSelections: unexpected,
      },
    };
    const instanceId = ProviderInstanceId.make("keyboard-model-test");
    const entry = deriveProviderInstanceEntries([
      {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-21T00:00:00Z",
        models: [],
        slashCommands: [],
        skills: [],
      } satisfies ServerProvider,
    ])[0]!;
    const chosen = vi.fn();
    function Picker() {
      const [open, setOpen] = useState(true);
      return (
        <ComposerHandleContext value={composer}>
          <ProviderModelPicker
            environmentId={null}
            activeInstanceId={instanceId}
            model="test-model"
            lockedProvider={null}
            isComposerOwned
            open={open}
            onOpenChange={setOpen}
            instanceEntries={[entry]}
            modelOptionsByInstance={
              new Map([[instanceId, [{ slug: "test-model", name: "Test model" }]]])
            }
            {...(keyboard
              ? {
                  restoreKeyboardFocus: () => {
                    requestNavigationMode();
                    return target;
                  },
                }
              : {})}
            onInstanceModelChange={chosen}
          />
        </ComposerHandleContext>
      );
    }
    target.focus();
    requestNavigationMode();
    await using _screen = await render(<Picker />);
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Choose current model"),
    );
    await userEvent.keyboard("{Enter}");
    expect(chosen).toHaveBeenCalledExactlyOnceWith(instanceId, "test-model");
    await vi.waitFor(() => expect(document.activeElement).toBe(keyboard ? target : draft));
    expect(isNavigationMode()).toBe(keyboard);
    expect(focusComposer).toHaveBeenCalledTimes(keyboard ? 0 : 1);
    expect(draft.value).toBe("Unchanged draft");
  },
);

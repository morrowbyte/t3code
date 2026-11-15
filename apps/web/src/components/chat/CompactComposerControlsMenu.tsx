import type { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, useRef } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode?: ProviderInteractionMode;
  showInteractionModeToggle?: boolean;
  onToggleInteractionMode?: (() => void) | undefined;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showPermissions: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const interactionMode = props.interactionMode ?? "default";
  const showInteractionModeToggle = props.showInteractionModeToggle ?? false;
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={props.showPermissions ? "composer.mode" : undefined}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={interactionMode}
              onValueChange={(value) => {
                if (!value || value === interactionMode) return;
                props.onToggleInteractionMode?.();
              }}
            >
              <MenuRadioItem value="default" disabled={!props.onToggleInteractionMode}>
                Chat
              </MenuRadioItem>
              <MenuRadioItem value="plan" disabled={!props.onToggleInteractionMode}>
                Plan
              </MenuRadioItem>
            </MenuRadioGroup>
            {props.showPermissions ? <MenuDivider /> : null}
          </>
        ) : null}
        {props.showPermissions ? (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
});

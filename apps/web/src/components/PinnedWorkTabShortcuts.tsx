import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { useClientSettings } from "../hooks/useSettings";
import { registerPinnedWorkTabNavigation } from "../shortcuts/pinnedWorkTabNavigation";
import { primaryServerKeybindingsAtom } from "../state/server";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useSidebar } from "./ui/sidebar";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";

export function PinnedWorkTabShortcuts() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const params = useParams({ strict: false });
  const threadRef = resolveThreadRouteRef(params);
  const settings = useClientSettings((current) => ({
    numericNavigationMode: current.numericNavigationMode,
    pinnedWorkTabs: current.pinnedWorkTabs,
  }));
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const terminalOpen = useTerminalUiStateStore((state) =>
    threadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, threadRef).terminalOpen
      : false,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers app-wide pin commands independently of the mobile sidebar portal
  useEffect(
    () =>
      registerPinnedWorkTabNavigation({
        settings: () => settings,
        keybindings: () => keybindings,
        terminalOpen: () => terminalOpen,
        navigate: (target) => {
          const selection = useThreadSelectionStore.getState();
          if (selection.selectedThreadKeys.size > 0) selection.clearSelection();
          selection.setAnchor(scopedThreadKey(target));
          if (isMobile) setOpenMobile(false);
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(target),
          });
        },
      }),
    [settings, keybindings, terminalOpen, navigate, isMobile, setOpenMobile],
  );
  return null;
}

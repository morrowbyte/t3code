import type { AnyRouter } from "@tanstack/react-router";
import { AgentIdentityTheme, type DesktopPetSpecies, type EnvironmentId } from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { useComposerDraftStore } from "../composerDraftStore";
import { readLocalStorageValue, subscribeLocalStorageKey } from "../hooks/useLocalStorage";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";

const LEGACY_THEME_KEY = "t3code:agent-identity-theme";

export function startDesktopPetSpecies(registry: AtomRegistry.AtomRegistry, router: AnyRouter) {
  const bridge = window.desktopBridge;
  if (!bridge?.setPetSpecies) return () => {};
  let environmentId: EnvironmentId | null = null;
  let stopSettings: (() => void) | undefined;
  let lastSent: DesktopPetSpecies | null | undefined;
  let selectionRevision = 0;
  let stopped = false;
  const sync = () => {
    const settings = environmentId
      ? registry.get(serverEnvironment.settingsValueAtom(environmentId))
      : null;
    const theme =
      settings?.agentIdentityTheme ??
      readLocalStorageValue(LEGACY_THEME_KEY, "neutral", AgentIdentityTheme);
    const species = theme === "neutral" ? null : theme;
    if (stopped || species === lastSent) return;
    lastSent = species;
    const revision = ++selectionRevision;
    void bridge.setPetSpecies(species).catch(() => {
      if (!stopped && selectionRevision === revision) lastSent = undefined;
    });
  };
  const selectEnvironment = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    const draft =
      target?.kind === "draft"
        ? useComposerDraftStore.getState().getDraftSession(target.draftId)
        : null;
    const next =
      target?.kind === "server"
        ? target.threadRef.environmentId
        : (draft?.environmentId ??
          (isAppModalPage(router.state.location.pathname) ? environmentId : null) ??
          registry.get(primaryEnvironmentIdAtom));
    if (next === environmentId && stopSettings) return;
    stopSettings?.();
    environmentId = next;
    stopSettings = next
      ? registry.subscribe(serverEnvironment.settingsValueAtom(next), sync)
      : undefined;
    sync();
  };
  const stops = [
    router.subscribe("onResolved", selectEnvironment),
    registry.subscribe(primaryEnvironmentIdAtom, selectEnvironment),
    useComposerDraftStore.subscribe(selectEnvironment),
    subscribeLocalStorageKey(LEGACY_THEME_KEY, sync),
  ];
  selectEnvironment();
  return () => {
    stopped = true;
    stopSettings?.();
    for (const stop of stops) stop();
  };
}

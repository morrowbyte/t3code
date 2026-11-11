import type { AppRestoreState } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export const appRestoreDialogAtom = Atom.make<{
  open: boolean;
  request: number;
  state: AppRestoreState | null;
  error: string | null;
}>({ open: false, request: 0, state: null, error: null }).pipe(
  Atom.keepAlive,
  Atom.withLabel("app-restore:dialog"),
);

export async function openAppRestore(): Promise<void> {
  const request = appAtomRegistry.get(appRestoreDialogAtom).request + 1;
  appAtomRegistry.set(appRestoreDialogAtom, { open: true, request, state: null, error: null });
  const api = window.desktopBridge?.appRestore;
  try {
    const state = api ? await api.list() : null;
    const current = appAtomRegistry.get(appRestoreDialogAtom);
    if (current.open && current.request === request)
      appAtomRegistry.set(appRestoreDialogAtom, { ...current, state });
  } catch {
    const current = appAtomRegistry.get(appRestoreDialogAtom);
    if (current.open && current.request === request)
      appAtomRegistry.set(appRestoreDialogAtom, {
        ...current,
        error:
          "Couldn't load previous versions. Try again or run t3 restore --list on this computer.",
      });
  }
}

export function closeAppRestore(): void {
  const current = appAtomRegistry.get(appRestoreDialogAtom);
  appAtomRegistry.set(appRestoreDialogAtom, { ...current, open: false });
}

import { createContext } from "react";

export const KeyboardLayerContext = createContext<string | null>(null);

const dismissals = new Map<string, () => void>();

export function registerKeyboardLayer(id: string, dismiss: () => void) {
  dismissals.set(id, dismiss);
  return () => {
    dismissals.delete(id);
  };
}

export function dismissRegisteredKeyboardLayer(layer: HTMLElement): boolean {
  const id = layer.dataset.keyboardLayer;
  const dismiss = id ? dismissals.get(id) : undefined;
  if (!dismiss) return false;
  dismiss();
  return true;
}

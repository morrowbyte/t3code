import { createContext, use, useState, useSyncExternalStore } from "react";
import { visualInteractions, type VisualInteraction } from "@t3tools/shared/streamableUi";

export const VisualInteractionScope = createContext<string | undefined>(undefined);

export function useVisualInteraction(id: string, kind: string) {
  const scope = use(VisualInteractionScope);
  const key = scope && id.startsWith("result-") ? JSON.stringify([scope, id, kind]) : undefined;
  const [local, setLocal] = useState<VisualInteraction>({ hidden: [] });
  const subscribe = (listener: () => void) =>
    key ? visualInteractions.subscribe(key, listener) : () => {};
  const read = () => (key ? visualInteractions.read(key) : local);
  const value = useSyncExternalStore(subscribe, read, read);
  const update = (change: (previous: VisualInteraction) => VisualInteraction) => {
    if (key) visualInteractions.write(key, change);
    else setLocal(change);
  };
  return [value, update] as const;
}

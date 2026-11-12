export interface VisualInteraction {
  readonly hidden: ReadonlyArray<string>;
  readonly openSections?: ReadonlyArray<string> | undefined;
  readonly selected?: string | undefined;
  readonly expanded?: boolean | undefined;
}

const empty: VisualInteraction = Object.freeze({ hidden: [] });

export function createVisualInteractionStore(limit = 256) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new RangeError("A positive retention limit is required.");
  const values = new Map<string, VisualInteraction>();
  const listeners = new Map<string, Set<() => void>>();
  const read = (key: string) => values.get(key) ?? empty;
  const write = (key: string, update: (previous: VisualInteraction) => VisualInteraction) => {
    const next = update(read(key));
    values.delete(key);
    values.set(key, next);
    while (values.size > limit) {
      const oldest = values.keys().next().value!;
      values.delete(oldest);
      listeners.get(oldest)?.forEach((listener) => listener());
    }
    listeners.get(key)?.forEach((listener) => listener());
  };
  const subscribe = (key: string, listener: () => void) => {
    const group = listeners.get(key) ?? new Set();
    group.add(listener);
    listeners.set(key, group);
    return () => {
      group.delete(listener);
      if (group.size === 0) listeners.delete(key);
    };
  };
  return { read, write, subscribe };
}

// Only interaction choices are retained; response data remains in the thread history.
export const visualInteractions = createVisualInteractionStore();

export function createCommentDictationDraft(ownerKey: string) {
  let current: { value: string; onChange: (value: string) => void } | null = null;
  const listeners = new Set<() => void>();
  return {
    ownerKey,
    update(value: string, onChange: (value: string) => void) {
      const changed = current?.value !== value;
      current = { value, onChange };
      if (changed) listeners.forEach((listener) => listener());
    },
    deactivate() {
      current = null;
      listeners.forEach((listener) => listener());
    },
    read: () => current?.value ?? null,
    commit(value: string) {
      current?.onChange(value);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

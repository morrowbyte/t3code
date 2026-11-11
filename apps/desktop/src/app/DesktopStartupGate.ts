export function startDesktopAfterRestore(input: {
  readonly recover: () => false | Promise<boolean>;
  readonly start: () => void;
  readonly restart: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly reportError: (cause: unknown) => void;
}): void | Promise<void> {
  const fail = (cause: unknown) => {
    input.reportError(cause);
    input.exit(1);
  };
  try {
    const recovery = input.recover();
    if (recovery === false) {
      input.start();
      return;
    }
    // Electron may already be ready after any async gate; only a fresh main may bootstrap Clerk.
    return recovery
      .then(async (recovering) => {
        if (!recovering) await input.restart();
        input.exit(0);
      })
      .catch(fail);
  } catch (cause) {
    fail(cause);
  }
}

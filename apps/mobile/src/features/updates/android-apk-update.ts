import {
  assertAndroidInstalledIdentity,
  androidNightlyVersionCode,
  parseAndroidReleaseIndex,
  verifyAndroidApkProof,
  type AndroidApkRelease,
  type AndroidInstalledIdentity,
  type AndroidApkProof,
} from "./android-apk-release";

export interface AndroidApkTransport {
  releases(signal: AbortSignal): Promise<unknown>;
  receipt(
    release: AndroidApkRelease,
    signal: AbortSignal,
  ): Promise<{ value: unknown; sha256: string }>;
  download(
    release: AndroidApkRelease,
    signal: AbortSignal,
    progress: (bytes: number) => void,
  ): Promise<string>;
  remove(uri: string): Promise<void>;
}

export interface AndroidApkNative {
  installed(): Promise<AndroidInstalledIdentity>;
  verify(uri: string, release: AndroidApkRelease, proof: AndroidApkProof): Promise<void>;
  install(
    uri: string,
    release: AndroidApkRelease,
    proof: AndroidApkProof,
  ): Promise<"permission-required" | "installer-opened">;
  openInstallPermission(): Promise<void>;
}

export type AndroidApkUpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "permission-required"
  | "installer-opened"
  | "cancelled"
  | "error";
export interface AndroidApkUpdateState {
  readonly phase: AndroidApkUpdatePhase;
  readonly release?: AndroidApkRelease;
  readonly installed?: AndroidInstalledIdentity;
  readonly bytes: number;
  readonly error?: string;
  readonly retry?: "check" | "download" | "install";
}

export function createAndroidApkUpdater(transport: AndroidApkTransport, native: AndroidApkNative) {
  let state: AndroidApkUpdateState = { phase: "idle", bytes: 0 };
  let active: AbortController | null = null;
  let generation = 0;
  let file: { uri: string; release: AndroidApkRelease; proof: AndroidApkProof } | null = null;
  const listeners = new Set<(state: AndroidApkUpdateState) => void>();
  const publish = (next: AndroidApkUpdateState) => {
    state = next;
    for (const listener of listeners) listener(next);
  };
  const valid = (id: number, signal: AbortSignal) => generation === id && !signal.aborted;
  const cleanup = async (uri: string) => {
    await transport.remove(uri);
  };
  const fail = (cause: unknown, retry: AndroidApkUpdateState["retry"]) =>
    publish({
      ...state,
      phase: "error",
      retry,
      error: cause instanceof Error ? cause.message : "The Android update failed.",
    });
  const begin = () => {
    if (active) return null;
    active = new AbortController();
    return { id: ++generation, controller: active };
  };
  const finish = (controller: AbortController) => {
    if (active === controller) active = null;
  };

  async function check() {
    const operation = begin();
    if (!operation) return;
    const { id, controller } = operation;
    publish({ phase: "checking", bytes: 0 });
    try {
      if (file) {
        const old = file;
        file = null;
        await cleanup(old.uri);
      }
      const installed = await native.installed();
      assertAndroidInstalledIdentity(installed);
      const releases = parseAndroidReleaseIndex(await transport.releases(controller.signal))
        .map((release) => ({ release, code: androidNightlyVersionCode(release.version) }))
        .sort((left, right) => {
          // Unbounded releases must be verified before Nightly bounds can prune the scan.
          if (left.code === null) return right.code === null ? 0 : -1;
          if (right.code === null) return 1;
          return right.code - left.code;
        });
      let candidate: { release: AndroidApkRelease; proof: AndroidApkProof } | null = null;
      let receiptFailure: { cause: unknown } | null = null;
      for (const { release, code } of releases) {
        if (!valid(id, controller.signal)) return;
        if (code !== null && code <= (candidate?.proof.versionCode ?? installed.versionCode))
          continue;
        try {
          const receipt = await transport.receipt(release, controller.signal);
          if (!valid(id, controller.signal)) return;
          const proof = verifyAndroidApkProof(receipt.value, release, receipt.sha256, installed);
          if (
            proof.versionCode > installed.versionCode &&
            (!candidate || proof.versionCode > candidate.proof.versionCode)
          )
            candidate = { release, proof };
        } catch (cause) {
          if (!valid(id, controller.signal)) return;
          if (cause instanceof Error && cause.name === "AbortError") throw cause;
          receiptFailure ??= { cause };
        }
      }
      if (!candidate && receiptFailure) throw receiptFailure.cause;
      if (valid(id, controller.signal))
        publish({
          phase: candidate ? "available" : "current",
          installed,
          bytes: 0,
          release: candidate?.release,
        });
    } catch (cause) {
      if (valid(id, controller.signal)) fail(cause, "check");
    } finally {
      finish(controller);
    }
  }

  async function download() {
    const release = state.release;
    if (!release || !["available", "cancelled", "error"].includes(state.phase)) return;
    const operation = begin();
    if (!operation) return;
    const { id, controller } = operation;
    let downloaded: string | null = null;
    publish({ ...state, phase: "downloading", bytes: 0, error: undefined, retry: undefined });
    try {
      const installed = await native.installed();
      const receipt = await transport.receipt(release, controller.signal);
      const proof = verifyAndroidApkProof(receipt.value, release, receipt.sha256, installed);
      if (proof.versionCode <= installed.versionCode)
        throw new Error("This update is already installed or older.");
      if (!valid(id, controller.signal)) return;
      downloaded = await transport.download(release, controller.signal, (bytes) => {
        if (valid(id, controller.signal))
          publish({ ...state, bytes: Math.min(Math.max(0, bytes), release.apk.size) });
      });
      if (!valid(id, controller.signal)) return;
      publish({ ...state, phase: "verifying", bytes: release.apk.size });
      await native.verify(downloaded, release, proof);
      if (!valid(id, controller.signal)) return;
      file = { uri: downloaded, release, proof };
      downloaded = null;
      publish({ ...state, phase: "ready" });
    } catch (cause) {
      if (valid(id, controller.signal)) fail(cause, "download");
    } finally {
      try {
        if (downloaded) await cleanup(downloaded);
      } finally {
        finish(controller);
      }
    }
  }

  async function install() {
    if (
      !file ||
      !["ready", "permission-required", "installer-opened", "error"].includes(state.phase)
    )
      return;
    const operation = begin();
    if (!operation) return;
    const { id, controller } = operation;
    const selected = file;
    publish({ ...state, phase: "installing", error: undefined });
    try {
      // The native installer rechecks the private file and installed signing identity at handoff.
      const phase = await native.install(selected.uri, selected.release, selected.proof);
      if (valid(id, controller.signal)) publish({ ...state, phase });
    } catch (cause) {
      if (valid(id, controller.signal)) fail(cause, "install");
    } finally {
      finish(controller);
    }
  }

  function cancel() {
    generation += 1;
    active?.abort();
    active = null;
    publish({ ...state, phase: "cancelled", bytes: 0, error: undefined });
  }

  return {
    getState: () => state,
    subscribe(listener: (next: AndroidApkUpdateState) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    check,
    download,
    install,
    cancel,
    async permission() {
      try {
        await native.openInstallPermission();
      } catch (cause) {
        fail(cause, "install");
      }
    },
    async retry() {
      if (state.retry === "install") await install();
      else if (state.retry === "download") await download();
      else await check();
    },
    async dispose() {
      listeners.clear();
      cancel();
      if (file) {
        const old = file;
        file = null;
        await cleanup(old.uri);
      }
    },
  };
}

export type AndroidApkUpdater = ReturnType<typeof createAndroidApkUpdater>;

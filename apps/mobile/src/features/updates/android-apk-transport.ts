import { AuthOrchestrationReadScope, type EnvironmentId } from "@t3tools/contracts";
import {
  consumeEnvironmentAndroidAppAsset,
  requestEnvironmentAndroidAppReleases,
} from "@t3tools/client-runtime/state/android-app-updates";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization/service";
import * as ManagedRelay from "@t3tools/client-runtime/relay/managed-relay";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AtomRegistry } from "effect/reactivity";
import type { HttpClient, HttpClientResponse } from "effect/http";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import { CryptoDigestAlgorithm, digest, randomUUID } from "expo-crypto";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession, readEnvironmentScope } from "../../state/session";
import { orphanedAndroidApkDownloadNames, type AndroidApkTransport } from "./android-apk-update";

class AndroidApkTransportError extends Schema.TaggedError<AndroidApkTransportError>()(
  "AndroidApkTransportError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const transportFailure = (operation: string, message: string) => (cause: unknown) =>
  new AndroidApkTransportError({ operation, message, cause });
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

type UpdateConnection = Parameters<typeof requestEnvironmentAndroidAppReleases>[0];
// Keep completed downloads protected until their updater releases the URI too.
const protectedDownloads = new Set<string>();

async function request<A, E>(
  environmentId: EnvironmentId,
  signal: AbortSignal,
  operation: (connection: UpdateConnection) => Effect.Effect<A, E, HttpClient.HttpClient>,
) {
  const services = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, connectionAtomRuntime, { suspendOnWaiting: true }),
    { signal },
  );
  if (!readEnvironmentScope(environmentId, AuthOrchestrationReadScope))
    throw new Error("This connection cannot read app updates.");
  const prepared = appAtomRegistry.get(
    environmentSession.preparedConnectionValueAtom(environmentId),
  );
  if (Option.isNone(prepared) || prepared.value.environmentId !== environmentId)
    throw new Error("Connect to the selected update host first.");
  const result = await Effect.runPromise(
    Effect.result(
      operation({
        prepared: prepared.value,
        signer: Context.getOption(services, ManagedRelay.ManagedRelayDpopSigner),
        remoteAuthorization: Context.getOption(services, RemoteEnvironmentAuthorization),
      }).pipe(Effect.provide(services), Effect.withTracerEnabled(false)),
    ),
    { signal },
  );
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
}

const readReceipt = Effect.fn("android-apk-transport.readReceipt")(function* (
  response: HttpClientResponse.HttpClientResponse,
  limit: number,
) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  yield* Stream.runForEach(response.stream, (chunk) => {
    length += chunk.byteLength;
    if (length > limit || length > 64_000)
      return Effect.fail(
        new AndroidApkTransportError({
          operation: "readReceipt",
          message: "The update receipt exceeds its size limit.",
        }),
      );
    chunks.push(chunk);
    return Effect.void;
  });
  if (length !== limit)
    return yield* new AndroidApkTransportError({
      operation: "readReceipt",
      message: "The update receipt is incomplete.",
    });
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const hash = yield* Effect.tryPromise({
    try: () => digest(CryptoDigestAlgorithm.SHA256, bytes),
    catch: transportFailure("hashReceipt", "Could not hash the update receipt."),
  });
  const value = yield* decodeReceipt(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(transportFailure("decodeReceipt", "The update receipt is not valid JSON.")),
  );
  return {
    value,
    sha256: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
});

export function createAndroidApkTransport(environmentId: EnvironmentId): AndroidApkTransport {
  return {
    releases: (signal) => request(environmentId, signal, requestEnvironmentAndroidAppReleases),
    receipt: (release, signal) =>
      request(environmentId, signal, (connection) =>
        consumeEnvironmentAndroidAppAsset({
          ...connection,
          releaseId: String(release.id),
          assetId: String(release.receipt.id),
          consume: (response) => readReceipt(response, release.receipt.size),
        }),
      ),
    async download(release, signal, progress) {
      const directory = new Directory(Paths.cache, "apk-updates");
      directory.create({ intermediates: true, idempotent: true });
      const orphaned = orphanedAndroidApkDownloadNames(
        directory.list().map((entry) => ({
          name: entry.name,
          uri: entry.uri,
          isFile: entry instanceof File,
        })),
        protectedDownloads,
      );
      for (const name of orphaned) new File(directory, name).delete();
      const file = new File(directory, `${randomUUID()}.apk`);
      file.create();
      protectedDownloads.add(file.uri);
      try {
        await request(environmentId, signal, (connection) =>
          consumeEnvironmentAndroidAppAsset({
            ...connection,
            releaseId: String(release.id),
            assetId: String(release.apk.id),
            consume: (response) =>
              Effect.acquireUseRelease(
                Effect.try({
                  try: () => file.open(FileMode.WriteOnly),
                  catch: transportFailure("openApk", "Could not open the APK download file."),
                }),
                (handle) => {
                  let bytes = 0;
                  let lastProgress = 0;
                  return Stream.runForEach(response.stream, (chunk) =>
                    Effect.gen(function* () {
                      if (signal.aborted)
                        return yield* new AndroidApkTransportError({
                          operation: "downloadApk",
                          message: "Download cancelled.",
                        });
                      bytes += chunk.byteLength;
                      if (bytes > release.apk.size)
                        return yield* new AndroidApkTransportError({
                          operation: "downloadApk",
                          message: "The APK exceeds its declared size.",
                        });
                      yield* Effect.tryPromise({
                        try: async () => {
                          await handle.writeBytes(chunk);
                        },
                        catch: transportFailure("writeApk", "Could not write the APK download."),
                      });
                      const now = yield* Clock.currentTimeMillis;
                      if (
                        !signal.aborted &&
                        (now - lastProgress >= 100 || bytes === release.apk.size)
                      ) {
                        yield* Effect.try({
                          try: () => progress(bytes),
                          catch: transportFailure(
                            "reportProgress",
                            "Could not report APK download progress.",
                          ),
                        });
                        lastProgress = now;
                      }
                    }).pipe(Effect.uninterruptible),
                  ).pipe(
                    Effect.andThen(() =>
                      bytes === release.apk.size
                        ? Effect.void
                        : Effect.fail(
                            new AndroidApkTransportError({
                              operation: "downloadApk",
                              message: "The APK download is incomplete.",
                            }),
                          ),
                    ),
                  );
                },
                (handle) => Effect.sync(() => handle.close()),
              ),
          }),
        );
        if (signal.aborted) throw new Error("Download cancelled.");
        return file.uri;
      } catch (cause) {
        protectedDownloads.delete(file.uri);
        if (file.exists) file.delete();
        throw cause;
      }
    },
    async remove(uri) {
      const file = new File(uri);
      try {
        if (file.exists) file.delete();
      } finally {
        protectedDownloads.delete(uri);
      }
    },
  };
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  directories: new Set<string>(),
  deleted: vi.fn(),
  download: vi.fn(),
  copy: vi.fn(),
  pickDirectory: vi.fn(),
  createFile: vi.fn(),
  write: vi.fn(),
  deleteFile: vi.fn(),
  share: vi.fn(),
  available: vi.fn(),
  open: vi.fn(),
  uuid: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    static pickDirectoryAsync = mocks.pickDirectory;
    readonly uri: string;

    constructor(...parts: Array<string | Directory>) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }

    get name(): string {
      return this.uri.split("/").at(-1)!;
    }

    get exists(): boolean {
      return mocks.directories.has(this.uri);
    }

    create(): void {
      mocks.directories.add(this.uri);
    }

    list(): Directory[] {
      const prefix = `${this.uri}/`;
      return [...mocks.directories]
        .filter((uri) => uri.startsWith(prefix) && !uri.slice(prefix.length).includes("/"))
        .map((uri) => new Directory(uri));
    }

    delete(): void {
      mocks.deleted(this.uri);
      mocks.directories.delete(this.uri);
    }

    createFile(name: string, mimeType: string): File {
      mocks.createFile(this.uri, name, mimeType);
      return new File(this, name);
    }
  }

  class File {
    static downloadFileAsync = mocks.download;
    readonly uri: string;

    constructor(source: Directory | string, name?: string) {
      this.uri = typeof source === "string" ? source : `${source.uri}/${encodeURIComponent(name!)}`;
    }

    async copy(destination: File): Promise<void> {
      await mocks.copy(this.uri, destination.uri);
    }

    readableStream(): ReadableStream<Uint8Array> {
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 255, 17, 0, 42]));
          controller.close();
        },
      });
    }

    writableStream(): WritableStream<Uint8Array> {
      return new WritableStream({ write: (chunk) => mocks.write(this.uri, chunk) });
    }

    delete(): void {
      mocks.deleteFile(this.uri);
    }
  }

  return { Directory, File, Paths: { cache: "file:///cache" } };
});

vi.mock("expo", () => ({ requireNativeModule: () => ({ openFile: mocks.open }) }));

vi.mock("expo-sharing", () => ({
  isAvailableAsync: mocks.available,
  shareAsync: mocks.share,
}));

vi.mock("./uuid", () => ({ uuidv4: mocks.uuid }));
vi.mock("./shareFileFromSource", () => ({ shareFileFromSource: mocks.share }));

import {
  downloadAndSaveAttachment,
  downloadAndShareAttachment,
  downloadAttachmentForPreview,
  nativeViewerErrorMessage,
  shareLocalAttachment,
} from "./attachmentDownload";
import { isForegroundHandoffActive } from "./foreground-handoff";
import { Directory } from "expo-file-system";

const NOW = 1_787_990_400_000;
const DAY_MS = 24 * 60 * 60_000;
const input = {
  url: "https://chosen-environment.example/api/assets/signed-token/report.pdf",
  attachment: { name: "report.pdf", mimeType: "application/pdf" },
};

beforeEach(() => {
  mocks.open.mockReset();
  mocks.open.mockResolvedValue(undefined);
  mocks.directories.clear();
  mocks.deleted.mockReset();
  mocks.download.mockReset();
  mocks.copy.mockReset();
  mocks.pickDirectory.mockReset();
  mocks.createFile.mockReset();
  mocks.write.mockReset();
  mocks.deleteFile.mockReset();
  mocks.pickDirectory.mockImplementation(async () => new Directory("content://chosen-directory"));
  mocks.write.mockResolvedValue(undefined);
  mocks.share.mockReset();
  mocks.available.mockReset();
  mocks.uuid.mockReset();
  mocks.download.mockImplementation(async (_url: string, file: { uri: string }) => file);
  mocks.copy.mockResolvedValue(undefined);
  mocks.share.mockResolvedValue(undefined);
  mocks.available.mockResolvedValue(true);
  let sequence = 0;
  mocks.uuid.mockImplementation(
    () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`,
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(isForegroundHandoffActive()).toBe(false);
});

describe("nativeViewerErrorMessage", () => {
  it.each([
    [
      "Call to function 'T3NativeControls.openFile' has been rejected.\n→ Caused by: No Activity found to handle Intent { act=android.intent.action.VIEW typ=application/vnd.openxmlformats-officedocument.wordprocessingml.document }",
      "No app on this device can show this format. Save or share it to open it elsewhere.",
    ],
    [
      "android.content.ActivityNotFoundException",
      "No app on this device can show this format. Save or share it to open it elsewhere.",
    ],
    [
      "This format cannot be previewed",
      "No app on this device can show this format. Save or share it to open it elsewhere.",
    ],
    [
      "The file could not be downloaded",
      "The file could not be opened. Check the connection and try again.",
    ],
  ])("classifies the native failure: %s", (message, expected) => {
    expect(nativeViewerErrorMessage(new Error(message))).toBe(expected);
  });
});

describe("downloadAndSaveAttachment", () => {
  it("saves binary bytes to the chosen directory without requiring a share receiver", async () => {
    mocks.available.mockResolvedValue(false);
    mocks.pickDirectory.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return new Directory("content://chosen-directory");
    });
    await expect(
      downloadAndSaveAttachment({
        ...input,
        attachment: { name: "../../result.bin", mimeType: "application/octet-stream" },
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(true);
    expect(mocks.download.mock.calls[0]?.[0]).toBe(input.url);
    expect(mocks.createFile).toHaveBeenCalledWith(
      "content://chosen-directory",
      "result.bin",
      "application/octet-stream",
    );
    expect(mocks.write.mock.calls.flatMap(([, chunk]) => Array.from(chunk))).toEqual([
      0, 255, 17, 0, 42,
    ]);
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(mocks.deleteFile).not.toHaveBeenCalled();
  });

  it("treats picker cancellation as no saved file and releases the temporary download", async () => {
    mocks.pickDirectory.mockRejectedValue(
      Object.assign(new Error("The file picker was cancelled by the user"), {
        code: "ERR_PICKER_CANCELLED",
      }),
    );
    await expect(
      downloadAndSaveAttachment({ ...input, signal: new AbortController().signal }),
    ).resolves.toBe(false);
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("does not create a document when its owner unmounts while the picker is open", async () => {
    const opened = Promise.withResolvers<void>();
    const picker = Promise.withResolvers<Directory>();
    mocks.pickDirectory.mockImplementation(() => {
      opened.resolve();
      return picker.promise;
    });
    const controller = new AbortController();
    const saving = downloadAndSaveAttachment({ ...input, signal: controller.signal });
    await opened.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    picker.resolve(new Directory("content://chosen-directory"));
    await expect(saving).resolves.toBe(false);
    expect(mocks.createFile).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it.each(["download", "picker", "copy"])(
    "reports a %s failure and removes only its own incomplete files",
    async (stage) => {
      const failure = new Error("Disk or transport failure");
      if (stage === "download") mocks.download.mockRejectedValue(failure);
      if (stage === "picker") mocks.pickDirectory.mockRejectedValue(failure);
      if (stage === "copy") mocks.write.mockRejectedValue(failure);
      await expect(
        downloadAndSaveAttachment({ ...input, signal: new AbortController().signal }),
      ).rejects.toThrow();
      expect(mocks.deleted).toHaveBeenCalledTimes(1);
      expect(mocks.deleteFile).toHaveBeenCalledTimes(stage === "copy" ? 1 : 0);
    },
  );

  it("settles an interrupted copy before removing its target and temporary download", async () => {
    const started = Promise.withResolvers<void>();
    const written = Promise.withResolvers<void>();
    mocks.write.mockImplementation(() => {
      started.resolve();
      return written.promise;
    });
    const controller = new AbortController();
    const saving = downloadAndSaveAttachment({ ...input, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    expect(mocks.deleteFile).not.toHaveBeenCalled();
    written.resolve();
    await expect(saving).resolves.toBe(false);
    expect(mocks.deleteFile).toHaveBeenCalledTimes(1);
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });
});

describe("downloadAndShareAttachment", () => {
  it("downloads the chosen environment's signed URL and shares the local file", async () => {
    const controller = new AbortController();
    await downloadAndShareAttachment({ ...input, signal: controller.signal });

    expect(mocks.download).toHaveBeenCalledWith(
      input.url,
      expect.objectContaining({ uri: expect.stringMatching(/\/report\.pdf$/) }),
      { signal: controller.signal },
    );
    expect(mocks.share).toHaveBeenCalledWith(
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
      {
        mimeType: "application/pdf",
        dialogTitle: "report.pdf",
      },
      undefined,
    );
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it.each([
    ["../../résumé.pdf", "résumé.pdf"],
    ["C:\\folder\\clip.mp4", "clip.mp4"],
    ["..", "attachment"],
    ["\ud800file\u0000.txt", "_file_.txt"],
  ])("uses a safe basename for %j", async (name, expected) => {
    await downloadAndShareAttachment({
      ...input,
      attachment: { ...input.attachment, name },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    expect(decodeURIComponent(file.uri.split("/").at(-1)!)).toBe(expected);
  });

  it("bounds the UTF-8 filename length while preserving its extension", async () => {
    await downloadAndShareAttachment({
      ...input,
      attachment: { name: `${"🙂".repeat(80)}.mp4`, mimeType: "video/mp4" },
      signal: new AbortController().signal,
    });
    const file = mocks.download.mock.calls[0]![1] as { uri: string };
    const name = decodeURIComponent(file.uri.split("/").at(-1)!);
    expect(name.endsWith(".mp4")).toBe(true);
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(255);
  });

  it("reports unavailable sharing before downloading or creating files", async () => {
    mocks.available.mockResolvedValue(false);
    await expect(
      downloadAndShareAttachment({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("Saving and sharing files is unavailable on this device.");
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.directories.size).toBe(0);
  });

  it("cleans an interrupted download only after the native request settles", async () => {
    const started = Promise.withResolvers<void>();
    const download = Promise.withResolvers<{ uri: string }>();
    mocks.download.mockImplementation(() => {
      started.resolve();
      return download.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({ ...input, signal: controller.signal });
    await started.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    download.reject(new Error("Canceled native request"));
    await task;
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("retains an export when its row unmounts during the native handoff", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementation(() => {
      expect(isForegroundHandoffActive()).toBe(true);
      opened.resolve();
      return share.promise;
    });
    const controller = new AbortController();
    const task = downloadAndShareAttachment({ ...input, signal: controller.signal });
    await opened.promise;
    controller.abort();
    share.resolve();
    await task;
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("cleans failed exports and releases the foreground handoff", async () => {
    mocks.share.mockRejectedValue(new Error("No activity can open this file"));
    await expect(
      downloadAndShareAttachment({ ...input, signal: new AbortController().signal }),
    ).rejects.toThrow("Could not open the share sheet. Try again.");
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it("does not prune an active export even if it passes the cache expiry", async () => {
    const opened = Promise.withResolvers<void>();
    const share = Promise.withResolvers<void>();
    mocks.share.mockImplementationOnce(() => {
      opened.resolve();
      return share.promise;
    });
    const first = downloadAndShareAttachment({ ...input, signal: new AbortController().signal });
    await opened.promise;
    vi.mocked(Date.now).mockReturnValue(NOW + DAY_MS + 1);

    await downloadAndShareAttachment({ ...input, signal: new AbortController().signal });
    expect(mocks.deleted).not.toHaveBeenCalled();
    share.resolve();
    await first;
  });
});

describe("attachment preview files", () => {
  it("does not start a native request after cancellation during setup", async () => {
    const controller = new AbortController();
    const loading = downloadAttachmentForPreview({ ...input, signal: controller.signal });
    controller.abort();
    await expect(loading).resolves.toBeNull();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.share).not.toHaveBeenCalled();
  });

  it("downloads for playback without requiring a share sheet and removes the file on close", async () => {
    mocks.available.mockResolvedValue(false);
    const file = await downloadAttachmentForPreview({
      ...input,
      signal: new AbortController().signal,
    });
    expect(file?.uri.endsWith("/report.pdf")).toBe(true);
    expect(mocks.available).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
    file?.dispose();
    file?.dispose();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "share-button"])(
    "keeps a shared preview after its owner closes (source: %s)",
    async (sourceIdentifier) => {
      const opened = Promise.withResolvers<void>();
      const sharing = Promise.withResolvers<void>();
      mocks.share.mockImplementationOnce(() => {
        opened.resolve();
        return sharing.promise;
      });
      const file = await downloadAttachmentForPreview({
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await opened.promise;
      file!.dispose();
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(true);
      sharing.resolve();
      await share;
      expect(isForegroundHandoffActive()).toBe(false);
      expect(mocks.deleted).not.toHaveBeenCalled();
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.copy).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "share-button"])(
    "does not share a disposed preview after availability checking (source: %s)",
    async (sourceIdentifier) => {
      const checking = Promise.withResolvers<void>();
      const available = Promise.withResolvers<boolean>();
      mocks.available.mockImplementation(() => {
        checking.resolve();
        return available.promise;
      });
      const file = await downloadAttachmentForPreview({
        ...input,
        signal: new AbortController().signal,
      });
      const share = file!.share(new AbortController().signal, sourceIdentifier);
      await checking.promise;
      file!.dispose();
      available.resolve(true);
      await share;
      expect(mocks.share).not.toHaveBeenCalled();
      expect(mocks.deleted).toHaveBeenCalledTimes(1);
    },
  );

  it("copies a local original before sharing without downloading or deleting the source", async () => {
    const uri = "file:///documents/draft/report.pdf";
    await shareLocalAttachment({
      uri,
      attachment: input.attachment,
      signal: new AbortController().signal,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      uri,
      expect.stringMatching(/^file:\/\/\/cache\/.+\/report\.pdf$/),
    );
    expect(mocks.share).toHaveBeenCalledWith(
      mocks.copy.mock.calls[0]![1],
      expect.any(Object),
      undefined,
    );
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it("waits for a local copy to finish before cleaning up a canceled share", async () => {
    const copying = Promise.withResolvers<void>();
    const copied = Promise.withResolvers<void>();
    mocks.copy.mockImplementation(() => {
      copying.resolve();
      return copied.promise;
    });
    const controller = new AbortController();
    const task = shareLocalAttachment({
      uri: "file:///documents/draft/report.pdf",
      attachment: input.attachment,
      signal: controller.signal,
    });
    await copying.promise;
    controller.abort();
    expect(mocks.deleted).not.toHaveBeenCalled();
    copied.resolve();
    await task;
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
  });
});

import {
  EnvironmentId,
  type YaziPickerPollResult,
  type YaziPickerReadResult,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  open: vi.fn<() => Promise<{ sessionId: string; homePath: string }>>(),
  poll: vi.fn<(sessionId: string) => Promise<YaziPickerPollResult>>(),
  read: vi.fn<
    (sessionId: string, fileId: string, offset: number) => Promise<YaziPickerReadResult>
  >(),
  write: vi.fn(async () => undefined),
  resize: vi.fn(async () => undefined),
  close: vi.fn(async (_sessionId: string) => undefined),
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../rpc/yaziPicker", () => ({
  openYaziPicker: { permissionAtom: () => null },
  yaziPickerApi: () => api,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "retry-environment", label: "Test host" }],
  }),
}));
vi.mock("../../state/session", () => ({ readPreparedConnection: () => null }));
vi.mock("../ThreadTerminalDrawer", () => ({ terminalThemeFromApp: () => ({}) }));
vi.mock("../../terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: { create: async () => ({ focus() {}, write() {}, dispose() {} }) },
}));

import { AttachmentPicker } from "./AttachmentPicker";
import { act, render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";
import { isNavigationMode, leaveNavigationMode, requestNavigationMode } from "./navigationMode";

const files = ["first", "second", "third"].map((id) => ({
  id,
  name: `${id}.txt`,
  mimeType: "text/plain",
  sizeBytes: id.length,
}));
function setup(): Disposable {
  for (const mock of Object.values(api)) mock.mockReset();
  api.open.mockResolvedValue({ sessionId: "retained-session", homePath: "/home/test" });
  api.poll.mockResolvedValue({ state: "completed", output: "", files });
  api.read.mockImplementation(async (_sessionId, id) => ({ dataBase64: btoa(id), eof: true }));
  api.write.mockResolvedValue(undefined);
  api.resize.mockResolvedValue(undefined);
  api.close.mockResolvedValue(undefined);
  leaveNavigationMode();
  return { [Symbol.dispose]: leaveNavigationMode };
}
function button(label: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!result) throw new Error(`Missing ${label} button`);
  return result;
}
async function mountPicker(onFiles: (files: File[]) => Promise<boolean>, onClose = vi.fn()) {
  await using resources = new AsyncDisposableStack();
  const screen = resources.use(
    await render(
      <AttachmentPicker
        environmentId={EnvironmentId.make("retry-environment")}
        targetKey="original-thread"
        onFiles={onFiles}
        onClose={onClose}
      />,
    ),
  );
  await act(async () => button("Thread environment").click());
  const cleanup = resources.move();
  return {
    onClose,
    unmount: screen.unmount,
    [Symbol.asyncDispose]: () => cleanup[Symbol.asyncDispose](),
  };
}
async function waitForRetry() {
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("second.txt"),
  );
  return button("Retry");
}

it("retains the completed selection and retries only failed and remaining files, once per Retry", async () => {
  using _setup = setup();
  let retryAllowed = false;
  const confirmed: string[] = [];
  const onFiles = vi.fn(async ([file]: File[]) => {
    if (file!.name === "second.txt" && !retryAllowed) return false;
    confirmed.push(await file!.text());
    return true;
  });
  await using screen = await mountPicker(onFiles);
  const { onClose } = screen;
  const retry = await waitForRetry();
  expect(confirmed).toEqual(["first"]);
  expect(api.close).not.toHaveBeenCalled();
  retryAllowed = true;
  await act(async () => {
    retry.click();
    retry.click();
  });
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(confirmed).toEqual(["first", "second", "third"]);
  expect(onFiles.mock.calls.map(([batch]) => batch[0]!.name)).toEqual([
    "first.txt",
    "second.txt",
    "second.txt",
    "third.txt",
  ]);
  expect(api.open).toHaveBeenCalledOnce();
  expect(api.poll).toHaveBeenCalledOnce();
  expect(api.read.mock.calls.map(([, id]) => id)).toEqual(["first", "second", "second", "third"]);
});

it.each(["unmount", "source change"])(
  "does not attach a retry response arriving after %s",
  async (exit) => {
    using _setup = setup();
    const onFiles = vi.fn(async ([file]: File[]) => file!.name !== "second.txt");
    await using screen = await mountPicker(onFiles);
    const { onClose } = screen;
    const retry = await waitForRetry();
    let finishRead!: (value: YaziPickerReadResult) => void;
    api.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    await act(async () => retry.click());
    expect(api.read).toHaveBeenCalledTimes(3);
    if (exit === "unmount") await screen.unmount();
    else await act(async () => button("This device").click());
    await act(async () => finishRead({ dataBase64: btoa("second"), eof: true }));
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledExactlyOnceWith("retained-session");
  },
);

it("can restart Yazi when startup failed before any selection existed", async () => {
  using _setup = setup();
  api.open.mockRejectedValueOnce(new Error("Yazi not ready"));
  const onFiles = vi.fn(async () => true);
  await using screen = await mountPicker(onFiles);
  const { onClose } = screen;
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Yazi not ready"),
  );
  await act(async () => button("Retry").click());
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(api.open).toHaveBeenCalledTimes(2);
  expect(onFiles).toHaveBeenCalledTimes(3);
});

it("keeps a partial browser selection in the dialog, replaces the failed file by keyboard, and restores NAV", async () => {
  using _setup = setup();
  const submitted = vi.fn();
  const confirmed: string[] = [];
  const onFiles = vi.fn(async ([file]: File[]) => {
    if (!file!.size) return false;
    confirmed.push(file!.name);
    return true;
  });
  using resources = new DisposableStack();
  const opener = document.createElement("button");
  resources.defer(() => opener.remove());
  opener.textContent = "Selected message";
  document.body.append(opener);
  opener.focus();
  requestNavigationMode();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitted();
          }}
        >
          <textarea aria-label="Unsent draft" defaultValue="Keep this unsent draft" />
          <button type="submit">Send</button>
        </form>
        {open ? (
          <AttachmentPicker
            environmentId={EnvironmentId.make("retry-environment")}
            targetKey="original-thread"
            onFiles={onFiles}
            onClose={() => setOpen(false)}
            restoreFocus={() => {
              requestNavigationMode();
              return opener;
            }}
          />
        ) : null}
      </>
    );
  }
  await using _screen = await render(<Harness />);
  const chosen = [
    new File(["ok"], "a-ok.txt"),
    new File([], "b-empty.txt"),
    new File(["replacement"], "c-ok.txt"),
  ];
  const input = document.querySelector<HTMLInputElement>(
    '[aria-label="Choose local attachment folder"]',
  )!;
  const transfer = new DataTransfer();
  for (const file of chosen) transfer.items.add(file);
  await act(async () => {
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const list = await vi.waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[role="listbox"][aria-label="Local files"]',
    );
    expect(document.activeElement).toBe(element);
    return element!;
  });
  await userEvent.keyboard("  {Control>}{Enter}{/Control}");
  await vi.waitFor(() =>
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("remaining selection"),
  );
  expect(confirmed).toEqual(["a-ok.txt"]);
  expect(document.activeElement).toBe(list);
  await userEvent.keyboard("{ArrowUp}  {Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(document.activeElement).toBe(opener));
  expect(confirmed).toEqual(["a-ok.txt", "c-ok.txt"]);
  expect(onFiles.mock.calls.map(([batch]) => batch[0]!.name)).toEqual([
    "a-ok.txt",
    "b-empty.txt",
    "c-ok.txt",
  ]);
  expect(submitted).not.toHaveBeenCalled();
  expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Unsent draft"]')!.value).toBe(
    "Keep this unsent draft",
  );
  expect(isNavigationMode()).toBe(true);
});

it("restores the original draft caret on cancellation after the dialog releases inert", async () => {
  using _setup = setup();
  using resources = new DisposableStack();
  const draft = document.createElement("textarea");
  resources.defer(() => draft.remove());
  draft.value = "Keep my original draft";
  document.body.append(draft);
  draft.focus();
  draft.setSelectionRange(5, 7);
  function Harness() {
    const [open, setOpen] = useState(true);
    return open ? (
      <AttachmentPicker
        environmentId={EnvironmentId.make("retry-environment")}
        targetKey="original-thread"
        onFiles={async () => true}
        onClose={() => setOpen(false)}
        restoreFocus={() => draft}
      />
    ) : null;
  }
  await using _screen = await render(<Harness />);
  await vi.waitFor(() => expect(document.activeElement).not.toBe(draft));
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(document.activeElement).toBe(draft));
  expect([draft.selectionStart, draft.selectionEnd]).toEqual([5, 7]);
  expect(draft.value).toBe("Keep my original draft");
});

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { LeaderNavigation } from "./LeaderNavigation";
import { leaveNavigationMode, requestNavigationMode } from "./navigationMode";
import { WorkbenchCommandPicker } from "./WorkbenchCommandPicker";
import { BrowserAttachmentExplorer, browserAttachmentDirectory } from "./BrowserAttachmentExplorer";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  leaveNavigationMode();
  vi.unstubAllGlobals();
});
const press = (keys: string) =>
  act(async () => {
    await userEvent.keyboard(keys);
  });

it("cycles out of a terminal nested inside the right-panel region in either direction", async () => {
  await act(() =>
    root.render(
      <>
        <main>
          <nav data-app-sidebar>
            <button>Threads</button>
          </nav>
          <div data-right-panel-surface-content>
            <aside data-keyboard-region="terminal">
              <button>Terminal session</button>
            </aside>
          </div>
          <div data-chat-composer-main-surface>
            <textarea aria-label="Draft" />
          </div>
        </main>
        <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />
      </>,
    ),
  );
  const terminal = host.querySelector<HTMLButtonElement>("aside button")!;
  await act(() => terminal.focus());
  await press("{F6}");
  expect.soft(document.activeElement).toBe(host.querySelector("textarea"));
  await act(() => terminal.focus());
  await press("{Shift>}{F6}{/Shift}");
  expect(document.activeElement).toBe(host.querySelector("nav button"));
});

it.each([" ", "{Enter}"])(
  "attaches the highlighted file after hiding entries with %s",
  async (key) => {
    const files = [".hidden.txt", "a.txt", "b.txt"].map((name) => new File([name], name));
    const directory = browserAttachmentDirectory(files)!;
    const received: File[] = [];
    await act(() =>
      root.render(
        <BrowserAttachmentExplorer
          root={directory}
          onFiles={async (selected) => {
            received.push(...selected);
            return true;
          }}
          onClose={() => {}}
        />,
      ),
    );
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Local files"),
    );
    await press(".{ArrowDown}{ArrowDown}.");
    expect(host.querySelector('[aria-current="true"]')?.textContent).toContain("b.txt");
    await press(key);
    if (key === " ") {
      expect(host.textContent).toContain("1 selected");
      await press("{Enter}");
    }
    await vi.waitFor(() => expect(received.map((file) => file.name)).toEqual(["b.txt"]));
    expect(await received[0]!.text()).toBe("b.txt");
  },
);

it("shows the focused object's help and executes only its selected action", async () => {
  const first = vi.fn();
  const second = vi.fn();
  await act(() =>
    root.render(
      <>
        <main>
          <div data-keyboard-region="Conversation">
            <article data-keyboard-object="Message" tabIndex={0}>
              <button onClick={first}>Copy first message</button>
            </article>
            <article data-keyboard-object="Message" tabIndex={0}>
              <button onClick={second}>Copy second message</button>
            </article>
          </div>
        </main>
        <LeaderNavigation groups={[]} isClaimed={() => false} showSidebar={() => {}} />
      </>,
    ),
  );
  const objects = host.querySelectorAll<HTMLElement>("article");
  objects[0]!.focus();
  await act(() => requestNavigationMode());
  await press("j?");
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Message keyboard help"]')).not.toBeNull(),
  );
  expect(document.body.textContent).toContain("Message actions");
  await press("{Escape}");
  await vi.waitFor(() => expect(document.activeElement).toBe(objects[1]));
  await press("{Shift>}{F10}{/Shift}");
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Search message actions"]')).not.toBeNull(),
  );
  await press("Copy second{Enter}");
  await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
  expect(first).not.toHaveBeenCalled();
});

it("restores the exact input selection and scrolling when an action picker is cancelled", async () => {
  const input = document.createElement("textarea");
  input.value = "An unchanged draft with a selected phrase";
  host.append(input);
  input.focus();
  input.setSelectionRange(3, 18, "backward");
  const mount = document.createElement("div");
  host.append(mount);
  const picker = createRoot(mount);
  try {
    await act(() =>
      picker.render(
        <WorkbenchCommandPicker
          title="Test actions"
          commands={[]}
          onClose={() => picker.render(null)}
        />,
      ),
    );
    await press("{Escape}");
    await vi.waitFor(() => expect(document.activeElement).toBe(input));
    expect(input.value).toBe("An unchanged draft with a selected phrase");
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
      3,
      18,
      "backward",
    ]);
  } finally {
    await act(() => picker.unmount());
  }
});

it("keeps three local selections across two folders, removes one, and attaches the exact remaining bytes", async () => {
  const file = (path: string, text: string) => {
    const file = new File([text], path.split("/").at(-1)!, { type: "text/plain" });
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    return file;
  };
  const directory = browserAttachmentDirectory([
    file("Granted/A/one.txt", "one"),
    file("Granted/A/two.txt", "two"),
    file("Granted/B/three.txt", "three"),
  ])!;
  const received: File[] = [];
  const close = vi.fn();
  await act(() =>
    root.render(
      <BrowserAttachmentExplorer
        root={directory}
        onFiles={async (files) => {
          received.push(...files);
          return true;
        }}
        onClose={close}
      />,
    ),
  );
  await vi.waitFor(() => expect(document.body.textContent).toContain("Parent folder"));
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Local files"),
  );
  await press("{Enter}");
  await vi.waitFor(() => expect(document.body.textContent).toContain("one.txt"));
  await press("  {ArrowLeft}");
  await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toBe("A"));
  await press("{ArrowDown}{Enter}");
  await vi.waitFor(() =>
    expect(document.querySelector('[role="option"]')?.textContent).toBe("three.txt"),
  );
  await press(" ");
  expect(document.body.textContent).toContain("3 selected");
  const remove = document.querySelector<HTMLButtonElement>(
    '[aria-label="Remove Granted/A/two.txt from selection"]',
  )!;
  remove.focus();
  await press("{Enter}");
  expect(document.body.textContent).toContain("2 selected");
  const attach = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Attach files",
  )!;
  attach.focus();
  await press("{Enter}");
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  expect(received.map((file) => file.name)).toEqual(["one.txt", "three.txt"]);
  expect(await Promise.all(received.map((file) => file.text()))).toEqual(["one", "three"]);
});

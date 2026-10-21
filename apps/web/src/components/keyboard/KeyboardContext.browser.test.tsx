import { act, render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { LeaderNavigation } from "./LeaderNavigation";
import { leaveNavigationMode, requestNavigationMode } from "./navigationMode";
import { WorkbenchCommandPicker } from "./WorkbenchCommandPicker";
import { BrowserAttachmentExplorer, browserAttachmentDirectory } from "./BrowserAttachmentExplorer";

function setup(): Disposable {
  return { [Symbol.dispose]: () => leaveNavigationMode() };
}
const press = (keys: string) => userEvent.keyboard(keys);

it("cycles out of a terminal nested inside the right-panel region in either direction", async () => {
  using _navigation = setup();
  await using _screen = await render(
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
    {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    },
  );
  const terminal = _screen.container.querySelector<HTMLButtonElement>("aside button")!;
  await act(() => terminal.focus());
  await press("{F6}");
  expect.soft(document.activeElement).toBe(_screen.container.querySelector("textarea"));
  await act(() => terminal.focus());
  await press("{Shift>}{F6}{/Shift}");
  expect(document.activeElement).toBe(_screen.container.querySelector("nav button"));
});

it.each([" ", "{Enter}"])(
  "attaches the highlighted file after hiding entries with %s",
  async (key) => {
    using _navigation = setup();
    const files = [".hidden.txt", "a.txt", "b.txt"].map((name) => new File([name], name));
    const directory = browserAttachmentDirectory(files)!;
    const received: File[] = [];
    await using _screen = await render(
      <BrowserAttachmentExplorer
        root={directory}
        onFiles={async (selected) => {
          received.push(...selected);
          return true;
        }}
        onClose={() => {}}
      />,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Local files"),
    );
    await press(".{ArrowDown}{ArrowDown}.");
    expect(_screen.container.querySelector('[aria-current="true"]')?.textContent).toContain(
      "b.txt",
    );
    await press(key);
    if (key === " ") {
      expect(_screen.container.textContent).toContain("1 selected");
      await press("{Enter}");
    }
    await vi.waitFor(() => expect(received.map((file) => file.name)).toEqual(["b.txt"]));
    expect(await received[0]!.text()).toBe("b.txt");
  },
);

it("shows the focused object's help and executes only its selected action", async () => {
  using _navigation = setup();
  const first = vi.fn();
  const second = vi.fn();
  await using _screen = await render(
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
    {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    },
  );
  const objects = _screen.container.querySelectorAll<HTMLElement>("article");
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
  using _navigation = setup();
  await using inputScreen = await render(
    <textarea defaultValue="An unchanged draft with a selected phrase" />,
    {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    },
  );
  const input = inputScreen.container.querySelector("textarea")!;
  input.focus();
  input.setSelectionRange(3, 18, "backward");
  await using picker = await render(
    <WorkbenchCommandPicker
      title="Test actions"
      commands={[]}
      onClose={() => void picker.rerender(null)}
    />,
    {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    },
  );
  await press("{Escape}");
  await vi.waitFor(() => expect(document.activeElement).toBe(input));
  expect(input.value).toBe("An unchanged draft with a selected phrase");
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([
    3,
    18,
    "backward",
  ]);
});

it("keeps three local selections across two folders, removes one, and attaches the exact remaining bytes", async () => {
  using _navigation = setup();
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
  await using _screen = await render(
    <BrowserAttachmentExplorer
      root={directory}
      onFiles={async (files) => {
        received.push(...files);
        return true;
      }}
      onClose={close}
    />,
    {
      // Standalone keyboard fixture; route navigation is outside this scenario.
      router: false,
    },
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

it.each(["rejected", "throws"])(
  "retries only the remaining local file after the second attachment %s",
  async (failure) => {
    using _navigation = setup();
    const directory = browserAttachmentDirectory([
      new File(["first bytes"], "one.txt"),
      new File(["second bytes"], "two.txt"),
    ])!;
    const attempted: File[][] = [];
    const accepted: File[] = [];
    const close = vi.fn();
    let retry = false;
    await using _screen = await render(
      <BrowserAttachmentExplorer
        root={directory}
        onFiles={async (files) => {
          attempted.push(files);
          if (files[0]?.name === "two.txt" && !retry) {
            if (failure === "throws") throw new Error("Attachment failed");
            return false;
          }
          accepted.push(...files);
          return true;
        }}
        onClose={close}
      />,
      {
        // Standalone keyboard fixture; route navigation is outside this scenario.
        router: false,
      },
    );
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe("Local files"),
    );
    await press("  {Enter}");
    await vi.waitFor(() =>
      expect(_screen.container.querySelector('[role="alert"]')).not.toBeNull(),
    );
    expect(close).not.toHaveBeenCalled();
    expect(attempted.map((files) => files.map((file) => file.name))).toEqual([
      ["one.txt"],
      ["two.txt"],
    ]);
    const selected = _screen.container.querySelector('[aria-label="Selected local files"]')!;
    expect(selected.textContent).toContain("two.txt");
    expect(selected.textContent).not.toContain("one.txt");
    expect(_screen.container.textContent).toContain("1 selected");
    expect(await accepted[0]!.text()).toBe("first bytes");

    retry = true;
    await press("{Enter}");
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
    expect(attempted.map((files) => files.map((file) => file.name))).toEqual([
      ["one.txt"],
      ["two.txt"],
      ["two.txt"],
    ]);
    expect(accepted.map((file) => file.name)).toEqual(["one.txt", "two.txt"]);
    expect(await Promise.all(accepted.map((file) => file.text()))).toEqual([
      "first bytes",
      "second bytes",
    ]);
  },
);

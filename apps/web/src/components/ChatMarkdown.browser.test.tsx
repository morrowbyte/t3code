import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import { countThreadSearchOccurrences } from "@t3tools/shared/threadSearch";
import { MarkdownFindContext } from "./chat/markdownFindContext";
import { useThreadFindHighlights } from "./chat/threadFindHighlights";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function linkTexts(container: HTMLElement) {
  return [...container.querySelectorAll("a")].map((link) => link.textContent);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

function fileOptions(container: HTMLElement) {
  return [...container.querySelectorAll("button")]
    .map((button) => button.getAttribute("aria-label"))
    .filter((label) => label?.startsWith("File options for "));
}

describe("ChatMarkdown math", () => {
  it("recognizes closed equations inside quotes and indented math fences while text keeps streaming", async () => {
    await using containerScreen = await renderText(
      "> $$\n> x^2\n> $$\n\n   ```math\n   y^2\n   ```\n\nStill streaming.",
      { isStreaming: true },
    );
    const container = containerScreen.container;
    await expect.poll(() => container.querySelectorAll("msup").length).toBe(2);
    expect(container.querySelectorAll('[data-math-state="pending"]')).toHaveLength(0);
  });
  it("renders completed inline and display equations and preserves their Markdown for copying", async () => {
    const inline = "$x^2$";
    const display = "$$\n\\frac{1}{2} + x = 3\n$$";
    await using containerScreen = await renderText(`Before ${inline}.\n\n${display}\n\nAfter.`);
    const container = containerScreen.container;
    await expect.poll(() => container.querySelectorAll("math").length).toBe(2);
    expect(container.querySelector("msup")).not.toBeNull();
    expect(container.querySelector("mfrac")).not.toBeNull();
    expect(
      [...container.querySelectorAll("[data-markdown-copy]")].map((node) =>
        node.getAttribute("data-markdown-copy"),
      ),
    ).toEqual([inline, display]);
    expect(container.querySelectorAll("pre, [data-markdown-math] code")).toHaveLength(0);
    expect(container.textContent).toContain("After.");
  });

  it("waits for the closing delimiter, keeps cancellation readable, and rehydrates a completed formula", async () => {
    const message = (text: string, isStreaming: boolean) => (
      <ChatMarkdown cwd={undefined} text={text} isStreaming={isStreaming} />
    );
    await using screen = await render(message("$$\n\\frac{", true));
    const { container, rerender } = screen;
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Formel…");
    expect(container.querySelector("math")).toBeNull();
    await rerender(message("$$\n\\frac{1}{2}", true));
    expect(container.querySelector("math")).toBeNull();
    await rerender(message("$$\n\\frac{1}{2}", false));
    expect(container.textContent).toBe("$$\n\\frac{1}{2}");
    expect(container.querySelector('[role="status"]')).toBeNull();
    const closed = "$$\n\\frac{1}{2}\n$$";
    await rerender(message(closed, true));
    await expect.poll(() => container.querySelectorAll("mfrac").length).toBe(1);
    await rerender(message(closed, false));
    expect(container.querySelectorAll("math")).toHaveLength(1);
    await using historyScreen = await renderText(closed);
    const history = historyScreen.container;
    await expect.poll(() => history.querySelectorAll("mfrac").length).toBe(1);
  });

  it("keeps an unfinished inline equation stable without interpreting prices and shell variables", async () => {
    await using screen = await render(
      <ChatMarkdown cwd={undefined} text={"Result $x=\\frac{"} isStreaming />,
    );
    const { container, rerender } = screen;
    expect(container.querySelector('[data-math-state="pending"]')).not.toBeNull();
    await rerender(
      <ChatMarkdown cwd={undefined} text={"Result $x=\\frac{1}{2}$ done"} isStreaming />,
    );
    await expect.poll(() => container.querySelectorAll("mfrac").length).toBe(1);
    expect(container.textContent).toContain("done");
    const literal = "Costs $5 and $10. Use $HOME/$PATH, or `echo $x^2$`. Escaped \\$x^2\\$.";
    await rerender(<ChatMarkdown cwd={undefined} text={literal} />);
    expect(container.querySelectorAll("math, [data-markdown-math]")).toHaveLength(0);
    expect(container.textContent).toContain("Costs $5 and $10.");
    expect(container.textContent).toContain("$HOME/$PATH");
    expect(container.querySelector("code")?.textContent).toBe("echo $x^2$");
  });

  it("keeps invalid TeX readable and disables active links and HTML commands", async () => {
    const raw = "$\\notARealCommand{x}$";
    await using containerScreen = await renderText(raw);
    const container = containerScreen.container;
    await expect
      .poll(() => container.querySelector('[data-math-state="source"]')?.textContent)
      .toBe(raw);
    await using unsafeScreen = await renderText(
      "$\\href{javascript:alert(1)}{click}$ and $\\htmlClass{injected}{x}$",
    );
    const unsafe = unsafeScreen.container;
    await expect.poll(() => unsafe.querySelectorAll('[data-math-state="pending"]').length).toBe(0);
    expect(unsafe.querySelectorAll("a, script, img, .injected")).toHaveLength(0);
  });

  it("retains correct math offsets after an incrementally cached visual fence", async () => {
    const prefix = '```t3-ui\n{"type":"metric","id":"m","label":"Count","value":"2"}\n```\n\n';
    await using screen = await render(
      <ChatMarkdown cwd={undefined} text={prefix + "$$\nx^"} streamableUi isStreaming />,
    );
    const { container, rerender } = screen;
    await rerender(
      <ChatMarkdown cwd={undefined} text={prefix + "$$\nx^2\n$$\n\nAfter."} streamableUi />,
    );
    await expect.poll(() => container.querySelectorAll("msup").length).toBe(1);
    expect(
      container.querySelector("[data-markdown-math]")?.getAttribute("data-markdown-copy"),
    ).toBe("$$\nx^2\n$$");
    expect(container.textContent).toContain("Count");
    expect(container.textContent).toContain("After.");
  });
});

describe("ChatMarkdown bare anchor placeholders", () => {
  it.each(["<A>", "<a>", "<a >", "<a/>", "<A/>", "<a />"])(
    "preserves unmatched %s without linking later blocks",
    async (token) => {
      await using containerScreen = await renderText(
        `- **"From ${token}"** appears in the header.\n\n- **Tests:** cover inheritance.\n\nThe deferred move continues on B.\n\nSee <a href="https://example.com">the link</a>.`,
      );
      const container = containerScreen.container;
      expect(container.querySelector("strong")?.textContent).toBe(`"From ${token}"`);
      expect(linkTexts(container)).toEqual(["the link"]);
      expect(container.querySelectorAll("li")).toHaveLength(2);
      expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toContain(
        "The deferred move continues on B.",
      );
    },
  );

  it.each(["</a>  ", "<div>more</div>\n</a>"])(
    "preserves a paired anchor closing in the raw block %s",
    async (closing) => {
      await using containerScreen = await renderText(`See <a>label\n\n${closing}\n\nfinish`);
      const container = containerScreen.container;
      expect(container.querySelector("p")?.textContent).toBe("See label");
    },
  );

  it("preserves a paired anchor after comment-looking raw text", async () => {
    await using containerScreen = await renderText("See <a>label<script><!-- </script> --></a>");
    const container = containerScreen.container;
    expect(container.querySelector("p")?.textContent).toBe("See label -->");
  });

  it.each(["<!-- </a> -->", '<div title="</a>">more</div>', '<script>"</a>"</script>'])(
    "ignores apparent closing anchors inside %s",
    async (html) => {
      await using containerScreen = await renderText(`Before <A>.\n\n${html}\n\nAfter.`);
      const container = containerScreen.container;
      expect(container.querySelector("p")?.textContent).toBe("Before <A>.");
      expect(container.querySelectorAll("a")).toHaveLength(0);
    },
  );

  it("preserves paired HTML anchors, details, markdown links, and inline code", async () => {
    await using containerScreen = await renderText(
      'Bare <a>label</a>, <a id="section"></a>, `<A>`, and [docs](https://example.com).\n\n<details><summary>More</summary>Details</details>',
    );
    const container = containerScreen.container;
    expect(linkTexts(container)).toEqual(["label", "", "docs"]);
    expect(container.querySelector("code")?.textContent).toBe("<A>");
    expect(container.querySelector("[data-markdown-details]")?.textContent).toContain("More");
  });
});

describe("ChatMarkdown context references", () => {
  it("renders text and image references through the chip renderer, with readable fallback", async () => {
    const text =
      "See [Terminal output](t3-context://v1/terminal/term-1) and ![Error image](t3-context://v1/image/img-1).";
    await using screen = await render(
      <ChatMarkdown
        cwd={undefined}
        text={text}
        renderContextReference={({ kind, label }) => (
          <button>
            {kind}: {label}
          </button>
        )}
      />,
    );
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "terminal: Terminal output",
      "image: Error image",
    ]);
    expect(container.querySelectorAll("img, a")).toHaveLength(0);
    await rerender(<ChatMarkdown cwd={undefined} text={text} />);
    expect(container.textContent).toBe("See Terminal output and Error image.");
    expect(container.querySelectorAll("img, a, button")).toHaveLength(0);
  });

  it("reads formatted context labels through nested markup instead of the context id", async () => {
    const seen: Array<string> = [];
    await using _screen = await render(
      <ChatMarkdown
        cwd={undefined}
        text="See [**Bold** `code`](t3-context://v1/terminal/term-1)."
        renderContextReference={({ kind, label }) => {
          seen.push(`${kind}: ${label}`);
          return <button>{label}</button>;
        }}
      />,
    );
    expect(new Set(seen)).toEqual(new Set(["terminal: Bold code"]));
  });
});

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown in-page links", () => {
  it.each([true, false])(
    "scrolls a table-of-contents link to its heading without touching the URL (parseRawHtml=%s)",
    async (parseRawHtml) => {
      const scrollIntoView = vi
        .spyOn(HTMLElement.prototype, "scrollIntoView")
        .mockImplementation(() => {});
      const href = window.location.href;
      await using containerScreen = await renderText(
        "- [Operating model](#1-operating-model)\n- [Missing](#nowhere)\n\n## 1. Operating model\n\n## 1. Operating model",
        { parseRawHtml },
      );
      const container = containerScreen.container;
      const headings = [...container.querySelectorAll("h2")];
      expect(headings.map((heading) => heading.id)).toEqual([
        "user-content-1-operating-model",
        "user-content-1-operating-model-1",
      ]);
      const [tocLink, missingLink] = [...container.querySelectorAll("a")];
      await act(async () => tocLink!.click());
      expect(scrollIntoView.mock.contexts).toEqual([headings[0]]);
      await act(async () => missingLink!.click());
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(window.location.href).toBe(href);
    },
  );
});

const ARTIFACT_TEMPLATE_DIRECTIVE =
  '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}';

describe("ChatMarkdown thread find", () => {
  function FindProbe(props: {
    container: HTMLElement;
    query: string;
    activeOccurrence?: number;
    children: ReactElement;
  }) {
    useThreadFindHighlights({
      container: props.container,
      query: props.query,
      activeRowId: "row",
      activeOccurrence: props.activeOccurrence ?? 0,
      onActiveRange: () => {},
    });
    return (
      <div data-timeline-row-id="row">
        <div data-thread-find-text>
          <MarkdownFindContext value={props.query !== ""}>{props.children}</MarkdownFindContext>
        </div>
      </div>
    );
  }
  const frame = () =>
    act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const activeHighlights = () =>
    [...(CSS.highlights.get("t3-thread-find-active") ?? [])].map((range) =>
      (range as Range).toString(),
    );

  it("opens a disclosure only when find selects a match inside it", async () => {
    await using screen = await render(<></>);
    const container = screen.container;
    using _highlights = { [Symbol.dispose]: () => CSS.highlights.clear() };
    const markdown = (
      <ChatMarkdown
        cwd={undefined}
        text={[
          "Visible needle.",
          "<details><summary>Unrelated</summary><p>nothing here</p></details>",
          "<details><summary>Outer</summary><details><summary>Inner</summary><p>needle</p></details></details>",
        ].join("\n\n")}
      />
    );
    const show = (query: string, activeOccurrence: number) =>
      act(() =>
        screen.rerender(
          <FindProbe container={container} query={query} activeOccurrence={activeOccurrence}>
            {markdown}
          </FindProbe>,
        ),
      );
    const openStates = () =>
      [...container.querySelectorAll<HTMLElement>("[data-markdown-details-open]")].map(
        (node) => node.dataset.markdownDetailsOpen,
      );

    await show("", 0);
    expect(container.textContent).not.toContain("nothing here");
    await show("needle", 0);
    await frame();
    expect(openStates()).toEqual(["false", "false", "false"]);
    expect(container.textContent).toContain("nothing here");
    expect(activeHighlights()).toEqual(["needle"]);
    expect(CSS.highlights.get("t3-thread-find")?.size ?? 0).toBe(0);

    await show("needle", 1);
    await frame();
    await frame();
    expect(openStates()).toEqual(["false", "true", "true"]);
    expect(CSS.highlights.get("t3-thread-find-active")?.size).toBe(1);
  });

  it("keeps Mermaid diagrams rendered until find selects a match in their source", async () => {
    await using screen = await render(<></>);
    const container = screen.container;
    using _highlights = { [Symbol.dispose]: () => CSS.highlights.clear() };
    const diagram = "```mermaid\ngraph TD; Alpha-->Beta\n```";
    const show = (query: string) =>
      act(() =>
        screen.rerender(
          <FindProbe container={container} query={query}>
            <ChatMarkdown cwd={undefined} text={`Needle first.\n\n${diagram}\n\n${diagram}`} />
          </FindProbe>,
        ),
      );
    const diagrams = () => container.querySelectorAll('svg[aria-label="Diagram"]').length;

    await show("Needle");
    await frame();
    expect(diagrams()).toBe(2);
    await show("Alpha");
    await frame();
    await frame();
    expect(diagrams()).toBe(1);
    await vi.waitFor(() => expect(activeHighlights()).toEqual(["Alpha"]));
  });

  it.each([
    {
      text: "```mermaid\ngraph TD; SearchSourceAlpha-->B\n```",
      query: "SearchSourceAlpha",
      count: 1,
    },
    {
      text: "★ Insight ─────\nfirst line\nsecond line",
      query: "first line second",
      count: 0,
      lineBreaks: true,
    },
    { text: '```ts title="src/needle.ts"\nconst a = 1;\n```', query: "needle", count: 0 },
    { text: "```weirdlang\nconst a = 1;\n```", query: "weirdlang", count: 0 },
    { text: "Use $test-t3-app now", query: "T3 App Testing", count: 1 },
    { text: "`/tmp/file.ts:42`", query: "file.ts · L42", count: 1, user: true, lineBreaks: true },
    { text: "> [!NOTE]\n> Searchable alert", query: "Searchable alert", count: 1 },
    {
      text: "<details><summary>Folded</summary><p>Hidden needle</p></details>",
      query: "Hidden needle",
      count: 1,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Hello World", count: 1, withTemplate: true },
    {
      text: ARTIFACT_TEMPLATE_DIRECTIVE,
      query: "Document template",
      count: 1,
      withTemplate: true,
    },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "World Document", count: 0, withTemplate: true },
    { text: ARTIFACT_TEMPLATE_DIRECTIVE, query: "Use template", count: 0, withTemplate: true },
  ])(
    "highlights the indexed occurrences of $query in $text",
    async ({ text, query, count, lineBreaks, user, withTemplate }) => {
      const skills = [{ name: "test-t3-app", displayName: "T3 App Testing" }];
      await using screen = await render(<></>);
      const container = screen.container;
      using _highlights = { [Symbol.dispose]: () => CSS.highlights.clear() };
      await act(() =>
        screen.rerender(
          <FindProbe container={container} query={query}>
            <ChatMarkdown
              text={text}
              cwd={undefined}
              skills={skills}
              lineBreaks={lineBreaks ?? false}
              parseRawHtml={!user}
              onUseArtifactTemplate={withTemplate ? () => undefined : undefined}
            />
          </FindProbe>,
        ),
      );
      await frame();
      // Lazy blocks such as Mermaid can swap their source text after the first frame,
      // emptying a range for a moment, so wait for the highlights to settle.
      await vi.waitFor(() => {
        const ranges = [...CSS.highlights.values()].flatMap((value) => [...value]);
        expect(ranges.map((range) => (range as Range).toString())).toEqual(
          Array.from({ length: count }, () => query),
        );
      });
      const segments =
        searchableMessageSegments(
          { role: user ? "user" : "assistant", text, streaming: false },
          undefined,
          skills,
        ) ?? [];
      expect(
        segments.reduce((sum, segment) => sum + countThreadSearchOccurrences(segment, query), 0),
      ).toBe(count);
    },
  );
});

describe("ChatMarkdown assistant visual fences", () => {
  it("preserves surrounding Markdown and progressively renders an unfinished visual fence only when enabled", async () => {
    await using screen = await render(<></>);
    const container = screen.container;
    using _highlights = { [Symbol.dispose]: () => CSS.highlights.clear() };
    const prefix =
      '**NVDA example** with a [citation](https://example.com/nvda).\n\n```t3-ui\n{"type":"table","id":"prices","title":"Daily close","columns":["Day","USD"]}\n{"type":"row","id":"prices","cells":["Day 1",123.45]}';
    const partial = prefix + '\n{"type":"row","id":"prices","cells":["Day 2",12';
    await act(async () =>
      screen.rerender(<ChatMarkdown text={prefix} cwd={undefined} isStreaming />),
    );
    expect(container.querySelector("[data-streamable-ui]")).toBeNull();
    await act(async () =>
      screen.rerender(<ChatMarkdown text={partial} cwd={undefined} isStreaming streamableUi />),
    );
    expect(container.querySelector("strong")?.textContent).toBe("NVDA example");
    expect(container.querySelector("a")?.textContent).toBe("citation");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("tbody")?.textContent).toContain("123.45");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Receiving");
    expect(container.querySelector("details")).toBeNull();

    await act(async () =>
      screen.rerender(<ChatMarkdown text={partial} cwd={undefined} streamableUi />),
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector("summary")?.textContent).toContain("line 3");

    const closed = partial + "4.56]}\n```\n\nStill streaming **normal text**.";
    await act(async () =>
      screen.rerender(<ChatMarkdown text={closed} cwd={undefined} isStreaming streamableUi />),
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(container.querySelector("tbody")?.textContent).toContain("124.56");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain("Still streaming normal text.");
    await act(async () =>
      screen.rerender(<ChatMarkdown text={closed} cwd={undefined} streamableUi />),
    );
    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
  });
});

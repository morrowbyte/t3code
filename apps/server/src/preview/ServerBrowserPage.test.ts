import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

describe("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.T3_TEST_CHROMIUM_EXECUTABLE_PATH
        ? { executablePath: process.env.T3_TEST_CHROMIUM_EXECUTABLE_PATH }
        : {}),
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = () =>
    ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("patches exact GUI text once while preserving all text outside the matches", async () => {
    await page.setContent(
      '<textarea id="source">Review. Restart. Wait30. Table30. Keep.</textarea><output id="events">0</output><script>source.oninput=()=>events.textContent=String(Number(events.textContent)+1)</script>',
    );
    expect(
      await ServerBrowserPage.patchText(page, {
        locator: "#source",
        edits: [
          { kind: "replace", old: "30", text: "45", count: 2 },
          { kind: "insert_before", old: "Restart.", text: "Inspect. ", count: 1 },
        ],
      }),
    ).toEqual({ editsApplied: 2, taskSuccessVerified: false });
    expect(await page.locator("#source").inputValue()).toBe(
      "Review. Inspect. Restart. Wait45. Table45. Keep.",
    );
    expect(await page.locator("#events").textContent()).toBe("1");
  });

  it("leaves the original field intact when any later edit has a wrong occurrence count", async () => {
    await page.setContent('<textarea id="source">old same same</textarea>');
    await expect(
      ServerBrowserPage.patchText(page, {
        locator: "#source",
        edits: [
          { kind: "replace", old: "old", text: "new", count: 1 },
          { kind: "replace", old: "same", text: "changed", count: 1 },
        ],
      }),
    ).rejects.toThrow("count mismatch");
    expect(await page.locator("#source").inputValue()).toBe("old same same");
  });

  it.each([
    "<textarea readonly>old</textarea>",
    "<textarea disabled>old</textarea>",
    "<textarea hidden>old</textarea>",
    "<div contenteditable>old</div>",
  ])("refuses unsupported text controls before writing: %s", async (html) => {
    await page.setContent(html);
    await expect(
      ServerBrowserPage.patchText(page, {
        locator: "body > :first-child",
        edits: [{ kind: "replace", old: "old", text: "new", count: 1 }],
      }),
    ).rejects.toThrow();
    expect(await page.locator("body").textContent()).toContain("old");
  });

  it("refuses a password before reading its value", async () => {
    await page.setContent('<input id="secret" type="password">');
    const locator = page.locator("#secret"),
      handle = (await locator.elementHandle())!;
    using target = vi.spyOn(page, "locator").mockReturnValue(locator);
    using retained = vi.spyOn(locator, "elementHandle").mockResolvedValue(handle);
    using valueRead = vi.spyOn(handle, "inputValue");
    await expect(
      ServerBrowserPage.patchText(page, {
        locator: "#secret",
        edits: [{ kind: "replace", old: "old", text: "new", count: 1 }],
      }),
    ).rejects.toThrow("plain-text");
    expect(valueRead).not.toHaveBeenCalled();
  });

  it("rejects stale snapshot refs before patching", async () => {
    await page.setContent("<textarea>old</textarea>");
    const snapshot = await takeSnapshot(),
      ref = locators(snapshot.accessibilityTree)[0]!;
    await takeSnapshot();
    await expect(
      ServerBrowserPage.patchText(page, {
        locator: ref,
        edits: [{ kind: "replace", old: "old", text: "new", count: 1 }],
      }),
    ).rejects.toThrow("stale");
    expect(await page.locator("textarea").inputValue()).toBe("old");
  });

  it("never writes to a replacement node after the planned field disappears", async () => {
    await page.setContent('<textarea id="source">old</textarea>');
    const locator = page.locator("#source"),
      handle = (await locator.elementHandle())!;
    using target = vi.spyOn(page, "locator").mockReturnValue(locator);
    using retained = vi.spyOn(locator, "elementHandle").mockResolvedValue(handle);
    const read = handle.inputValue.bind(handle);
    let reads = 0;
    using replaced = vi.spyOn(handle, "inputValue").mockImplementation(async () => {
      const value = await read();
      if (++reads === 2)
        await page.evaluate(`(() => {
          const replacement = document.createElement("textarea");
          replacement.id = "source";
          replacement.value = "different";
          document.querySelector("#source").replaceWith(replacement);
        })()`);
      return value;
    });
    await expect(
      ServerBrowserPage.patchText(page, {
        locator: "#source",
        timeoutMs: 100,
        edits: [{ kind: "replace", old: "old", text: "new", count: 1 }],
      }),
    ).rejects.toThrow();
    expect(await page.locator("#source").inputValue()).toBe("different");
  });

  it("keeps semantic reads and fresh refs usable when pixel capture is unavailable", async () => {
    await page.setContent(
      '<input type="password" value="private-value"><span>private-value</span><button onclick="this.textContent=\'Done\'">Save</button>',
    );
    const send = cdp.send.bind(cdp);
    using capture = vi.spyOn(cdp, "send").mockImplementation((method, ...args) => {
      if (method === "Page.captureScreenshot") return Promise.reject(new Error("No pixel capture"));
      return send(method, ...args);
    });
    const result = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      includeScreenshot: false,
    });
    expect(result.screenshot).toBeUndefined();
    expect(result.accessibilityTree).not.toContain("[box=");
    expect(result.accessibilityTree).toContain('button "Save"');
    expect(String(result.accessibilityTree)).not.toContain("private-value");
    expect(result.visibleText).not.toContain("private-value");
    expect(capture.mock.calls.some(([method]) => method === "Page.captureScreenshot")).toBe(false);
    await ServerBrowserPage.click(page, {
      locator: buttonLocator(result.accessibilityTree, "Save"),
      timeoutMs: 1_000,
    });
    expect(await page.getByRole("button").innerText()).toBe("Done");
  });

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it.each(["covered", "disabled"])(
    "refuses an in-viewport %s target without dispatching its click",
    async (kind) => {
      await page.setContent(
        `<button id="target" ${kind === "disabled" ? "disabled" : ""} style="position:absolute;left:20px;top:20px;width:150px;height:50px" onclick="window.hits++">Save</button>${kind === "covered" ? '<div style="position:fixed;inset:0;z-index:10;background:white">Blocking dialog</div>' : ""}<script>window.hits=0</script>`,
      );
      await expect(
        ServerBrowserPage.click(page, { locator: "#target", timeoutMs: 200 }),
      ).rejects.toThrow();
      expect(await page.evaluate("window.hits")).toBe(0);
    },
  );

  it("scrolls an offscreen semantic target into view and clicks only that target", async () => {
    await page.setContent(
      '<button onclick="window.wrong++">Decoy</button><div style="height:2000px"></div><button id="target" onclick="window.hits++">Save</button><script>window.hits=0;window.wrong=0</script>',
    );
    await ServerBrowserPage.click(page, { locator: "#target", timeoutMs: 2_000 });
    expect(
      await page.evaluate("({hits:window.hits,wrong:window.wrong,scrolled:scrollY>0})"),
    ).toEqual({
      hits: 1,
      wrong: 0,
      scrolled: true,
    });
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    // Page text masks the same values, so it can't be compared against the tree.
    expect(result.visibleText).toContain("Order ••••••••-2");
    expect(tree).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    // Masked before the cut, so no prefix of the value is left.
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("shows a data: link or blocked data: navigation by media type only", async () => {
    // Chromium keeps raw spaces and quotes in both, so a payload can't be cut at either.
    await page.setContent(`
      <a download href="data:text/plain;charset=&quot;a,b&quot;,head PAYLOAD'tail">Key</a>
      <a href="https://example.com/data:report,2026">Report</a>
      <a href="#">data:text/plain,label</a>
      <a href='"data:text/plain,relative'>Relative</a>
      <a href=" data:text/plain,PAYLOAD">Spaced</a>
      <a href="da&#9;ta:text/plain,PAYLOAD">Tabbed</a>
      <a href="data:text/plain,head&#x2028;PAYLOAD">Separated</a>
      <a href="data:PAYLOAD,x">Typeless</a>
      <a href="&#11;data:text/plain,PAYLOAD">Vertical tab</a>
      <a href="&#8;data:text/plain,PAYLOAD">Backspace</a>
      <a id="controlled">Controlled</a>
      <a id="escaped">Escaped</a>
      <script>
        controlled.href = "\\x01data:text/plain,PAYLOAD";
        escaped.href = "\\x02da\\tta:text/plain,PAYLOAD";
      </script>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree.match(/\/url: data:text\/plain,…$/gm)).toHaveLength(8);
    expect(tree).toContain("/url: data:,…");
    expect(tree).toContain("/url: https://example.com/data:report,2026");
    expect(tree).toMatch(/link "data:text\/plain,label" \[ref=t3-/);
    expect(tree).not.toMatch(/PAYLOAD|tail|charset|\u2028/);
    expect(tree).toContain('/url: "\\"data:text/plain,relative"');
  });

  it("redacts a data: link whose scheme a password value would mask", async () => {
    await page.setContent(`
      <input type="password" aria-label="Scheme" value="data">
      <a download href="data:text/plain,PAYLOAD">Key</a>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree).toContain("/url: ••••••••:text/plain,…");
    expect(tree).not.toContain("PAYLOAD");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("right-clicks, double-clicks, hovers, selects, and drags like a pointer user", async () => {
    await page.setContent(`
      <style>#menu { position: absolute; display: none } #hover:hover + #menu { display: block }</style>
      <button id="target">target</button>
      <div id="hover">hover me</div><div id="menu">menu item</div>
      <select id="size"><option value="s">Small</option><option value="l">Large</option></select>
      <div id="card" draggable="true">card</div><div id="lane" style="height:40px">lane</div>
      <p id="log"></p>
      <script>
        const log = (text) => (document.getElementById("log").textContent += text + ";");
        const target = document.getElementById("target");
        target.addEventListener("contextmenu", (event) => { event.preventDefault(); log("context"); });
        target.addEventListener("dblclick", () => log("dblclick"));
        document.getElementById("card").addEventListener("dragstart", (event) =>
          event.dataTransfer.setData("text/plain", "card"),
        );
        for (const type of ["dragenter", "dragover"])
          document.getElementById("lane").addEventListener(type, (event) => event.preventDefault());
        document.getElementById("lane").addEventListener("drop", () => log("drop"));
      </script>`);
    await ServerBrowserPage.click(page, { locator: "#target", button: "right" });
    await ServerBrowserPage.click(page, { locator: "#target", clickCount: 2 });
    await ServerBrowserPage.hover(page, { locator: "#hover" });
    expect(await page.isVisible("#menu")).toBe(true);
    expect(await ServerBrowserPage.select(page, { locator: "#size", values: ["Large"] })).toEqual({
      selected: ["l"],
    });
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" });
    expect(await page.textContent("#log")).toBe("context;dblclick;drop;");
    await expect(
      ServerBrowserPage.select(page, { locator: "#target", values: ["s"] }),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTargetNotEditableError" });
  });

  it("shows the agent's pointer at each target before the action reaches the page", async () => {
    await page.setContent(`
      <button id="go" style="position:absolute;left:100px;top:40px;width:80px;height:20px">go</button>
      <div id="tip" style="position:absolute;left:300px;top:40px;width:60px;height:20px">tip</div>
      <div id="card" draggable="true" style="position:absolute;left:20px;top:120px;width:40px;height:40px">card</div>
      <div id="lane" style="position:absolute;left:220px;top:120px;width:100px;height:40px">lane</div>
      <script>
        window.seen = [];
        go.onclick = () => seen.push("click");
        tip.onmouseenter = () => seen.push("hover");
        card.ondragstart = (event) => event.dataTransfer.setData("text/plain", "card");
        lane.ondragover = (event) => event.preventDefault();
        lane.ondrop = () => seen.push("drop");
      </script>`);
    const shown: Array<string> = [];
    const pointer: ServerBrowserPage.PointerReporter = async ({ x, y }, phase) => {
      const seen = await page.evaluate("window.seen.length");
      shown.push(`${phase}@${Math.round(x)},${Math.round(y)} after ${seen}`);
    };
    await ServerBrowserPage.click(page, { locator: "#go" }, pointer);
    await ServerBrowserPage.hover(page, { locator: "#tip" }, pointer);
    await ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }, pointer);
    expect(shown).toEqual([
      "click@140,50 after 0",
      "move@330,50 after 1",
      "move@40,140 after 2",
      "move@270,140 after 2",
    ]);
    expect(await page.evaluate("window.seen")).toEqual(["click", "hover", "drop"]);
  });

  it("keeps the native user agent and client hints unchanged through the first popup request", async () => {
    const native = await cdp.send("Browser.getVersion");
    const requests: Array<{ userAgent: string | undefined; hints: string | undefined }> = [];
    // The intercepted HTTPS origin is local to this context and never reaches the network.
    await context.route("https://example.test/**", (route) => {
      if (route.request().isNavigationRequest()) {
        const headers = route.request().headers();
        requests.push({ userAgent: headers["user-agent"], hints: headers["sec-ch-ua"] });
      }
      return route.fulfill({ contentType: "text/html", body: "<p>native identity</p>" });
    });
    const readIdentity = (target: Page) =>
      target.evaluate<{
        userAgent: string;
        brands: Array<{ brand: string; version: string }>;
        full: Array<{ brand: string; version: string }>;
        webdriver: boolean;
      }>(`(async () => ({
      userAgent: navigator.userAgent,
      brands: navigator.userAgentData.brands,
      full: (await navigator.userAgentData.getHighEntropyValues(["fullVersionList"]))
        .fullVersionList,
      webdriver: navigator.webdriver,
    }))()`);
    await page.goto("https://example.test/");
    const identity = await readIdentity(page);
    expect(identity.userAgent).toBe(native.userAgent);
    expect(identity.webdriver).toBe(true);
    const opened = context.waitForEvent("page");
    await page.evaluate("window.open('https://example.test/popup')");
    const popup = await opened;
    await popup.waitForLoadState("domcontentloaded");
    expect(await readIdentity(popup)).toEqual(identity);
    expect(requests).toHaveLength(2);
    expect(requests[0]!.userAgent).toBe(native.userAgent);
    expect(requests[1]).toEqual(requests[0]);
    for (const brand of identity.brands)
      expect(requests[0]!.hints).toContain(JSON.stringify(brand.brand));
  });

  it("stops an evaluation at its deadline so the page answers the next one", async () => {
    await expect(
      ServerBrowserPage.evaluate(cdp, { expression: "for (;;) {}" }, 200),
    ).rejects.toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    expect(await ServerBrowserPage.evaluate(cdp, { expression: "1 + 1" }, 2_000)).toBe(2);
  });
});

describe("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

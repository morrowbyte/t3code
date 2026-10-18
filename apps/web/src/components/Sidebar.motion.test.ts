import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createSidebarFamilyMotion, createSidebarListMotion } from "./Sidebar.motion";

class TestAnimation {
  currentTime = 0;
  progress: number | null = 0;
  playState: AnimationPlayState = "running";
  effect = { getComputedTiming: () => ({ progress: this.progress }) };
  cancel = vi.fn(() => {
    this.playState = "idle";
  });
  private onFinish: (() => void) | undefined;
  addEventListener(_type: string, listener: () => void) {
    this.onFinish = listener;
  }
  finish() {
    this.playState = "finished";
    this.onFinish?.();
  }
}

class TestRow {
  offsetTop = 0;
  offsetLeft = 4;
  offsetWidth = 260;
  namespaceURI = "http://www.w3.org/1999/xhtml";
  dragTranslate = 0;
  style: Record<string, string> = {};
  inert = false;
  attributes: { name: string; value: string }[] = [];
  children: TestRow[] = [];
  clones: TestRow[] = [];
  remove = vi.fn();
  animations: TestAnimation[] = [];
  constructor(
    readonly name: string,
    public offsetHeight = 82,
  ) {}
  getBoundingClientRect() {
    return { top: this.offsetTop + this.dragTranslate, height: this.offsetHeight };
  }
  setAttribute(name: string, value: string) {
    this.removeAttribute(name);
    this.attributes.push({ name, value });
  }
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  }
  getAttribute(name: string) {
    return this.attributes.find((attribute) => attribute.name === name)?.value ?? null;
  }
  querySelectorAll(_selector: string): TestRow[] {
    return this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
  }
  cloneNode(_deep: boolean): TestRow {
    const clone = new TestRow(`${this.name} clone`, this.offsetHeight);
    clone.namespaceURI = this.namespaceURI;
    clone.style = { ...this.style };
    clone.attributes = this.attributes.map((attribute) => ({ ...attribute }));
    clone.children = this.children.map((child) => child.cloneNode(true));
    this.clones.push(clone);
    return clone;
  }
  animate = vi.fn((_frames: Keyframe[], _options: KeyframeAnimationOptions) => {
    const animation = new TestAnimation();
    this.animations.push(animation);
    return animation;
  });
}

function fixture(rows: TestRow[]) {
  const media = { matches: false };
  const parent = {
    children: rows,
    ownerDocument: { defaultView: { matchMedia: () => media } },
    getBoundingClientRect: () => ({ top: 0 }),
    append(node: TestRow) {
      parent.children.push(node);
      node.remove.mockImplementation(() => {
        parent.children = parent.children.filter((child) => child !== node);
      });
    },
  };
  function layout(next: TestRow[]) {
    let top = 8;
    for (const row of next) {
      row.offsetTop = top;
      top += row.offsetHeight + 1;
    }
    parent.children = [
      ...next,
      ...parent.children.filter((row) => row.style.position === "absolute"),
    ];
  }
  layout(rows);
  const motion = createSidebarListMotion(parent as unknown as HTMLUListElement);
  return { motion, layout, media, parent };
}

function expectMove(row: TestRow, offset: number) {
  expect(row.animate).toHaveBeenLastCalledWith(
    [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
    { duration: 150, easing: "ease-out" },
  );
}

beforeEach(() => vi.stubGlobal("HTMLElement", TestRow));
afterEach(() => vi.unstubAllGlobals());

describe("sidebar family motion", () => {
  function familyFixture(open = true) {
    const group = new TestRow("family");
    const media = { matches: false };
    const clip = Object.assign(new TestRow("clip", open ? 160 : 0), {
      ownerDocument: { defaultView: { matchMedia: () => media } },
    });
    const content = { scrollHeight: 160 };
    const motion = createSidebarFamilyMotion(
      group as unknown as HTMLElement,
      clip as unknown as HTMLElement,
      content as HTMLElement,
    );
    motion.update(open);
    return { group, clip, content, motion, media };
  }

  it("animates the clipped descendants' height in both directions", () => {
    const { group, clip, motion } = familyFixture();
    const settled = vi.fn();
    motion.update(false, settled);
    expect(clip.animate).toHaveBeenLastCalledWith([{ height: "160px" }, { height: "0px" }], {
      duration: 150,
      easing: "ease-out",
    });
    expect(group.getAttribute("data-sidebar-family-resizing")).toBe("true");
    expect(settled).not.toHaveBeenCalled();
    clip.animations[0]!.finish();
    clip.offsetHeight = 0;
    expect(settled).toHaveBeenCalledWith(false);
    expect(clip.style.height).toBe("0px");
    expect(group.getAttribute("data-sidebar-family-resizing")).toBeNull();
    motion.update(true, settled);
    expect(clip.animate).toHaveBeenLastCalledWith([{ height: "0px" }, { height: "160px" }], {
      duration: 150,
      easing: "ease-out",
    });
    clip.animations[1]!.finish();
    expect(clip.style.height).toBe("auto");
    expect(settled).toHaveBeenLastCalledWith(true);
  });

  it("reverses from the current height and ignores the canceled completion", () => {
    const { clip, motion } = familyFixture();
    const settled = vi.fn();
    motion.update(false, settled);
    const closing = clip.animations[0]!;
    clip.offsetHeight = 63;
    motion.update(true, settled);
    expect(closing.cancel).toHaveBeenCalledOnce();
    expect(clip.animate).toHaveBeenLastCalledWith([{ height: "63px" }, { height: "160px" }], {
      duration: 150,
      easing: "ease-out",
    });
    closing.finish();
    expect(settled).not.toHaveBeenCalled();
    motion.update(true, settled);
    expect(clip.animations).toHaveLength(2);
    clip.animations[1]!.finish();
    expect(settled).toHaveBeenCalledExactlyOnceWith(true);
    expect(clip.style.height).toBe("auto");
  });

  it("retargets a changed descendant height during opening without replaying status updates", () => {
    const { clip, content, motion } = familyFixture(false);
    motion.update(true);
    clip.offsetHeight = 54;
    content.scrollHeight = 240;
    motion.update(true);
    expect(clip.animate).toHaveBeenLastCalledWith([{ height: "54px" }, { height: "240px" }], {
      duration: 150,
      easing: "ease-out",
    });
    clip.animations[1]!.finish();
    motion.update(true);
    expect(clip.animations).toHaveLength(2);
  });

  it("respects reduced motion and cancels only its owned animation on disposal", () => {
    const { group, clip, motion, media } = familyFixture();
    const settled = vi.fn();
    media.matches = true;
    motion.update(false, settled);
    expect(clip.animate).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledWith(false);
    media.matches = false;
    clip.offsetHeight = 0;
    motion.update(true, settled);
    motion.dispose();
    expect(clip.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(group.getAttribute("data-sidebar-family-resizing")).toBeNull();
    motion.update(false);
    expect(clip.animations).toHaveLength(1);
  });
});

describe("sidebar list motion", () => {
  it("lets the family height move neighbours without adding a second transform", () => {
    const group = new TestRow("family", 242);
    const next = new TestRow("next");
    const { motion, layout } = fixture([group, next]);
    motion.update(true);
    group.setAttribute("data-sidebar-family-resizing", "true");
    group.offsetHeight = 160;
    layout([group, next]);
    motion.update(true);
    expect(next.animate).not.toHaveBeenCalled();
    group.removeAttribute("data-sidebar-family-resizing");
    group.offsetHeight = 82;
    layout([group, next]);
    motion.update(false);
    motion.update(true);
    expect(next.animate).not.toHaveBeenCalled();
    layout([next, group]);
    motion.update(true);
    expectMove(next, 83);
  });
  it("moves a retained Active row into Settled with its displaced peers", () => {
    const pinnedHeader = new TestRow("Pinned", 0);
    const pinned = new TestRow("pin");
    const divider = new TestRow("Active", 0);
    const a = new TestRow("a");
    const b = new TestRow("b");
    const settledHeader = new TestRow("Settled", 32);
    const settled = new TestRow("settled", 36);
    const rows = [pinnedHeader, pinned, divider, a, b, settledHeader, settled];
    const { motion, layout } = fixture(rows);
    motion.update(true);
    expect(rows.every((row) => row.animations.length === 0)).toBe(true);

    a.offsetHeight = 36;
    layout([pinnedHeader, pinned, divider, b, settledHeader, settled, a]);
    motion.update(true);
    expectMove(a, -153);
    expectMove(b, 83);
    expectMove(settledHeader, 83);
    expectMove(settled, 83);
    expect(pinned.animate).not.toHaveBeenCalled();
    expect(divider.animate).not.toHaveBeenCalled();
  });

  it("refreshes the drop baseline without replay and animates the next ordinary move", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 300;
    b.dragTranslate = -83;
    motion.update(false);
    motion.suspend();
    layout([b, a, c]);
    a.dragTranslate = b.dragTranslate = 0;
    motion.update(true);
    expect([a, b, c].every((row) => row.animations.length === 0)).toBe(true);

    layout([c, b, a]);
    motion.update(true);
    expectMove(c, 166);
    expectMove(b, -83);
    expectMove(a, -83);
  });

  it("glides every row from its released position into its committed slot", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 130;
    b.dragTranslate = -83;
    c.dragTranslate = 16;
    motion.update(false);
    motion.release();
    layout([b, a, c]);
    a.dragTranslate = b.dragTranslate = c.dragTranslate = 0;
    motion.update(true);
    expectMove(a, 47);
    expect(b.animations).toHaveLength(0);
    expectMove(c, 16);
  });

  it("does not glide on release when motion is reduced", () => {
    const [a, b] = [new TestRow("a"), new TestRow("b")];
    const { motion, layout, media } = fixture([a, b]);
    motion.update(true);
    media.matches = true;
    a.dragTranslate = 100;
    motion.release();
    layout([b, a]);
    a.dragTranslate = 0;
    motion.update(true);
    expect(a.animations).toHaveLength(0);
    expect(b.animations).toHaveLength(0);
  });

  it("does not carry a canceled drag's transformed position into the next move", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    motion.suspend();
    a.dragTranslate = 500;
    b.dragTranslate = -83;
    motion.update(false);
    motion.suspend();
    a.dragTranslate = b.dragTranslate = 0;
    motion.update(true);
    expect(a.animate).not.toHaveBeenCalled();
    expect(b.animate).not.toHaveBeenCalled();

    layout([b, a]);
    motion.update(true);
    expectMove(a, -83);
    expectMove(b, 83);
  });

  it("retargets rapid changes from the current visual position", () => {
    const [a, b, c] = [new TestRow("a", 99), new TestRow("b", 99), new TestRow("c", 99)];
    const { motion, layout } = fixture([a, b, c]);
    motion.update(true);
    layout([b, c, a]);
    motion.update(true);
    expectMove(a, -200);
    const first = a.animations[0]!;
    first.progress = 0.25;

    layout([b, a, c]);
    motion.update(true);
    expect(first.cancel).toHaveBeenCalledOnce();
    expectMove(a, -50);
    first.finish();
    motion.suspend();
    expect(a.animations[1]!.cancel).toHaveBeenCalledOnce();
  });

  it("keeps an uninterrupted movement when the layout position does not change", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.5;
    motion.update(true);
    expect(a.animate).toHaveBeenCalledOnce();
    expect(a.animations[0]!.cancel).not.toHaveBeenCalled();
  });

  it("cancels owned motion on suspension and never animates a disposed list", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    motion.suspend();
    expect(a.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(b.animations[0]!.cancel).toHaveBeenCalledOnce();
    motion.update(false);
    layout([a, b]);
    motion.update(true);
    motion.dispose();
    expect(a.animations[1]!.cancel).toHaveBeenCalledOnce();
    layout([b, a]);
    motion.update(true);
    expect(a.animate).toHaveBeenCalledTimes(2);
  });

  it("fades a collapsed-shelf exit at its current visual box and a new wake in", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const fresh = new TestRow("new");
    a.setAttribute("data-thread-item", "a");
    a.children = [new TestRow("button")];
    a.children[0]!.setAttribute("id", "thread-control");
    a.children[0]!.setAttribute("data-testid", "thread-control");
    a.children[0]!.setAttribute("data-state", "open");
    const icon = new TestRow("provider icon");
    icon.namespaceURI = "http://www.w3.org/2000/svg";
    icon.setAttribute("id", "provider-mask");
    icon.setAttribute("mask", "url(#provider-mask)");
    a.children.push(icon);
    const { motion, layout, parent } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.5;
    layout([b, fresh]);
    motion.update(true);
    expect(a.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(fresh.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: "translateY(83px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      {
        duration: 150,
        easing: "ease-out",
      },
    );
    const clone = a.clones[0]!;
    expect(clone.style).toMatchObject({
      position: "absolute",
      top: "49.5px",
      left: "4px",
      width: "260px",
      height: "82px",
      transform: "none",
      pointerEvents: "none",
    });
    expect(clone.inert).toBe(true);
    expect(clone.attributes).toEqual([{ name: "aria-hidden", value: "true" }]);
    expect(clone.children[0]!.attributes).toEqual([{ name: "data-state", value: "open" }]);
    expect(clone.children[1]!.attributes).toEqual(icon.attributes);
    expect(clone.animate).toHaveBeenCalledWith(
      [
        { opacity: 1, transform: "translateY(0px)" },
        { opacity: 0, transform: "translateY(-83px)" },
      ],
      {
        duration: 150,
        easing: "ease-out",
      },
    );
    expect(parent.children.includes(clone)).toBe(true);
    motion.update(true);
    expect(clone.animations).toHaveLength(1);
    expect(clone.clones).toHaveLength(0);
    clone.animations[0]!.finish();
    expect(parent.children.includes(clone)).toBe(false);
  });

  it("rides entering rows on the shelf displacement so an opened shelf moves as one block", () => {
    const a = new TestRow("a", 40);
    const header = new TestRow("header", 32);
    const x = new TestRow("x", 36);
    const y = new TestRow("y", 36);
    const z = new TestRow("z", 36);
    const { motion, layout } = fixture([a, header, x]);
    motion.update(true);
    layout([a, header, x, y, z]);
    for (const row of [header, x, y, z]) row.offsetTop -= 72;
    motion.update(true);
    expectMove(header, 72);
    expectMove(x, 72);
    expect(a.animate).not.toHaveBeenCalled();
    expect(y.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: "translateY(72px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    expect(z.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: "translateY(72px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
  });

  it("rides new rows on a retained header's unfinished travel", () => {
    const header = new TestRow("header", 32);
    const above = new TestRow("above", 39);
    const incoming = new TestRow("incoming", 36);
    const { motion, layout } = fixture([header]);
    motion.update(true);
    layout([above, header]);
    motion.update(true);
    header.animations[0]!.progress = 0.25;
    layout([above, header, incoming]);
    motion.update(true);
    expect(incoming.animate).toHaveBeenLastCalledWith(
      [
        { opacity: 0, transform: "translateY(-30px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
  });

  it("cancels in-flight row travel when a bulk update skips animation", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout } = fixture([a, b]);
    motion.update(true);
    layout([b, a]);
    motion.update(true);
    const first = a.animations[0]!;
    first.progress = 0.4;
    const incoming = Array.from({ length: 41 }, (_, index) => new TestRow(`new-${index}`));
    layout(incoming);
    motion.update(true);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(incoming.every((row) => row.animate.mock.calls.length === 0)).toBe(true);
  });

  it("keeps in-flight shelf entry travel when the shelf closes mid-animation", () => {
    const a = new TestRow("a", 40);
    const header = new TestRow("header", 32);
    const x = new TestRow("x", 36);
    const y = new TestRow("y", 36);
    const { motion, layout } = fixture([a, header, x]);
    motion.update(true);
    layout([a, header, x, y]);
    for (const row of [header, x, y]) row.offsetTop -= 36;
    motion.update(true);
    const entry = y.animations[0]!;
    header.animations[0]!.progress = 0.25;
    x.animations[0]!.progress = 0.25;
    entry.progress = 0.25;
    layout([a, header, x]);
    motion.update(true);
    expect(entry.cancel).toHaveBeenCalledOnce();
    const clone = y.clones[0]!;
    expect(clone.style.top).toBe("110px");
    expect(clone.animate).toHaveBeenCalledWith(
      [
        { opacity: 0.25, transform: "translateY(0px)" },
        { opacity: 0, transform: "translateY(9px)" },
      ],
      { duration: 150, easing: "ease-out" },
    );
    expectMove(header, -9);
    expectMove(x, -9);
  });

  it("clears exit clones on pickup and does not fade the release commit", () => {
    const [a, b, c] = [new TestRow("a"), new TestRow("b"), new TestRow("c")];
    const { motion, layout, parent } = fixture([a, b]);
    motion.update(false);
    layout([b]);
    motion.update(true);
    const clone = a.clones[0]!;
    motion.suspend();
    expect(clone.animations[0]!.cancel).toHaveBeenCalledOnce();
    expect(parent.children.includes(clone)).toBe(false);
    motion.update(false);
    motion.suspend();
    layout([c]);
    motion.update(true);
    expect(b.clones).toHaveLength(0);
    expect(c.animations).toHaveLength(0);
    layout([c, a]);
    motion.update(true);
    expect(a.animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: "translateY(0px)" },
        { opacity: 1, transform: "translateY(0px)" },
      ],
      {
        duration: 150,
        easing: "ease-out",
      },
    );
    motion.dispose();
    expect(a.animations.at(-1)!.cancel).toHaveBeenCalledOnce();
  });

  it("carries entry opacity into a quick exit and removes artifacts on a silent update", () => {
    const a = new TestRow("a");
    const marker = new TestRow("boundary", 0);
    const { motion, layout, parent } = fixture([marker]);
    motion.update(false);
    layout([marker, a]);
    motion.update(true);
    a.animations[0]!.progress = 0.4;
    layout([]);
    motion.update(true);
    expect(marker.clones).toHaveLength(0);
    const clone = a.clones[0]!;
    expect(clone.animate).toHaveBeenCalledWith(
      [
        { opacity: 0.4, transform: "translateY(0px)" },
        { opacity: 0, transform: "translateY(40px)" },
      ],
      {
        duration: 150,
        easing: "ease-out",
      },
    );
    motion.update(false);
    expect(parent.children).toEqual([]);
    expect(clone.animations[0]!.cancel).toHaveBeenCalledOnce();
  });

  it("retargets an in-flight entry when a later layout shift moves the row", () => {
    const a = new TestRow("a", 40);
    const header = new TestRow("header", 32);
    const x = new TestRow("x", 36);
    const y = new TestRow("y", 36);
    const { motion, layout } = fixture([a, header, x]);
    motion.update(true);
    layout([a, header, x, y]);
    for (const row of [header, x, y]) row.offsetTop -= 36;
    motion.update(true);
    const entry = y.animations[0]!;
    entry.progress = 0.25;
    for (const row of [header, x, y]) row.offsetTop += 40;
    motion.update(true);
    expect(entry.cancel).not.toHaveBeenCalled();
    expectMove(y, -13);
  });

  it("skips fades when a large list change would clone too many rows", () => {
    const rows = Array.from({ length: 41 }, (_, index) => new TestRow(`row-${index}`));
    const { motion, layout, parent } = fixture(rows);
    motion.update(true);
    layout([]);
    motion.update(true);
    expect(rows.every((row) => row.clones.length === 0)).toBe(true);
    expect(parent.children).toHaveLength(0);
    const entering = Array.from({ length: 41 }, (_, index) => new TestRow(`new-${index}`));
    layout(entering);
    motion.update(true);
    expect(entering.every((row) => row.animate.mock.calls.length === 0)).toBe(true);
  });

  it("still slides rows when one removal displaces a large list", () => {
    const rows = Array.from({ length: 60 }, (_, index) => new TestRow(`row-${index}`));
    const { motion, layout } = fixture(rows);
    motion.update(true);
    const [removed, ...rest] = rows;
    layout(rest);
    motion.update(true);
    expect(removed!.clones).toHaveLength(1);
    expect(rest.every((row) => row.animations.length === 1)).toBe(true);
  });

  it("respects reduced motion while keeping the next baseline fresh", () => {
    const a = new TestRow("a");
    const b = new TestRow("b");
    const { motion, layout, media } = fixture([a, b]);
    motion.update(true);
    media.matches = true;
    layout([b, a]);
    motion.update(true);
    expect(a.animate).not.toHaveBeenCalled();
    media.matches = false;
    layout([a, b]);
    motion.update(true);
    expectMove(a, 83);
    expectMove(b, -83);
  });
});

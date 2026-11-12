import { describe, expect, it } from "vite-plus/test";
import { annotationPoint } from "./ImageAnnotation";
import { applyImageAnnotation } from "./ImageAnnotationSend";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";

describe("annotationPoint", () => {
  it("keeps image-space coordinates through fit, zoom, pan and narrow layouts", () => {
    for (const bounds of [
      { left: 80, top: 120, width: 720, height: 400 },
      { left: -160, top: -90, width: 1440, height: 800 },
      { left: 16, top: 200, width: 358, height: 199 },
    ]) {
      const point = annotationPoint(
        { clientX: bounds.left + bounds.width * 0.75, clientY: bounds.top + bounds.height * 0.2 },
        bounds,
      );
      expect(point?.x).toBeCloseTo(0.75);
      expect(point?.y).toBeCloseTo(0.2);
    }
  });

  it("clips captured pointers at the image edges and rejects unusable bounds", () => {
    const bounds = { left: 10, top: 20, width: 100, height: 50 };
    expect(annotationPoint({ clientX: -100, clientY: 100 }, bounds)).toEqual({ x: 0, y: 1 });
    expect(annotationPoint({ clientX: 10, clientY: 20 }, { ...bounds, width: 0 })).toBeNull();
    expect(annotationPoint({ clientX: NaN, clientY: 20 }, bounds)).toBeNull();
  });
});

describe("applyImageAnnotation", () => {
  it.each(["apply", "question", "cancel", "switch", "replace", "unreadable"] as const)(
    "preserves the draft through %s without sending a message",
    async (outcome) => {
      const store = useComposerDraftStore.getState();
      const target = DraftId.make(`annotation-${outcome}`);
      const file = new File(["original"], "shot.png", { type: "image/png" });
      const image = {
        type: "image" as const,
        id: "image",
        file,
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
      };
      const other = {
        ...image,
        id: "other",
        name: "other.png",
        previewUrl: URL.createObjectURL(file),
      };
      store.addImages(target, [image, other], { allowDuplicates: true });
      store.setPrompt(target, "Unsent text\nwith spacing.");
      const before = store.getComposerDraft(target)!;
      const controller = new AbortController();
      if (outcome === "cancel") controller.abort();
      let reads = 0;
      let answer = "Existing answer";
      try {
        const pending = applyImageAnnotation({
          draftTarget: target,
          image,
          file:
            outcome === "unreadable"
              ? new File(["invalid"], "bad.heic", { type: "image/heic" })
              : new File(["annotated"], "marked.png", { type: "image/png" }),
          text: "Check the marked area.",
          signal: controller.signal,
          isCurrent: () => outcome !== "switch" || ++reads === 1,
          ...(outcome === "question"
            ? {
                onComment: (text: string) => {
                  answer = `${answer}\n\n${text}`;
                },
              }
            : {}),
        });
        if (outcome === "replace") store.removeImage(target, image.id);
        if (outcome === "unreadable") {
          await expect(pending).rejects.toThrow("could not be prepared");
        } else {
          expect(await pending).toBe(outcome === "apply" || outcome === "question");
        }
        const after = store.getComposerDraft(target)!;
        expect(after.images.at(-1)).toBe(other);
        expect(after.files).toBe(before.files);
        if (outcome === "apply" || outcome === "question") {
          expect(after.prompt).toBe(
            outcome === "question" ? before.prompt : `${before.prompt}\n\nCheck the marked area.`,
          );
          if (outcome === "question")
            expect(answer).toBe("Existing answer\n\nCheck the marked area.");
          expect(after.images[0]?.id).toBe(image.id);
          expect(await after.images[0]?.file?.text()).toBe("annotated");
        } else {
          expect(after.prompt).toBe(before.prompt);
          if (outcome !== "replace") expect(after).toBe(before);
        }
      } finally {
        store.clearDraftThread(target);
      }
    },
  );
});

import { expect, it } from "vite-plus/test";
import { readYaziAttachment } from "./yaziAttachment";

const file = { id: "one", name: "Grüße file.txt", mimeType: "text/plain", sizeBytes: 5 };

it("preserves selected bytes, Unicode filenames and MIME across read chunks", async () => {
  const offsets: number[] = [];
  const result = await readYaziAttachment(
    file,
    async (offset) => {
      offsets.push(offset);
      return offset === 0
        ? { dataBase64: btoa("hel"), eof: false }
        : { dataBase64: btoa("lo"), eof: true };
    },
    () => false,
  );
  expect(offsets).toEqual([0, 3]);
  expect(result?.name).toBe(file.name);
  expect(result?.type).toBe(file.mimeType);
  expect(await result?.text()).toBe("hello");
});

it("does not attach data that arrives after cancellation", async () => {
  let cancel = false;
  const result = await readYaziAttachment(
    file,
    async () => {
      cancel = true;
      return { dataBase64: btoa("hello"), eof: true };
    },
    () => cancel,
  );
  expect(result).toBeNull();
});

it("rejects a truncated or non-progressing selected file", async () => {
  await expect(
    readYaziAttachment(
      file,
      async () => ({ dataBase64: btoa("hi"), eof: true }),
      () => false,
    ),
  ).rejects.toThrow("changed");
  await expect(
    readYaziAttachment(
      file,
      async () => ({ dataBase64: "", eof: false }),
      () => false,
    ),
  ).rejects.toThrow("changed");
});

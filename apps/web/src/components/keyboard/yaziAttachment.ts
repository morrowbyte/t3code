import type { YaziPickerFile } from "@t3tools/contracts";

export async function readYaziAttachment(
  file: YaziPickerFile,
  read: (offset: number) => Promise<{ dataBase64: string; eof: boolean }>,
  cancelled: () => boolean,
) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  while (!cancelled()) {
    const chunk = await read(offset);
    if (cancelled()) return null;
    const bytes = Uint8Array.from(atob(chunk.dataBase64), (character) => character.charCodeAt(0));
    chunks.push(bytes);
    offset += bytes.byteLength;
    if (offset > file.sizeBytes || (!chunk.eof && bytes.byteLength === 0))
      throw new Error("The selected file changed. Select it again.");
    if (chunk.eof) {
      if (offset !== file.sizeBytes) throw new Error("The selected file changed. Select it again.");
      return new File(chunks, file.name, { type: file.mimeType });
    }
  }
  return null;
}

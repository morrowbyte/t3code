import { DesktopPetNativeEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decode = Schema.decodeUnknownSync(DesktopPetNativeEvent, { onExcessProperty: "error" });
export const MAX_PET_LINE_BYTES = 16_384;

export function createPetDecoder(receive: (event: DesktopPetNativeEvent) => void) {
  let pending = Buffer.alloc(0);
  return (chunk: Buffer): void => {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 10) continue;
      const line = Buffer.concat([pending, chunk.subarray(start, i)]);
      if (line.length > MAX_PET_LINE_BYTES) throw new Error("protocol-limit");
      receive(decode(JSON.parse(line.toString("utf8"))));
      pending = Buffer.alloc(0);
      start = i + 1;
    }
    if (pending.length + chunk.length - start > MAX_PET_LINE_BYTES) {
      throw new Error("protocol-limit");
    }
    pending = Buffer.concat([pending, chunk.subarray(start)]);
  };
}

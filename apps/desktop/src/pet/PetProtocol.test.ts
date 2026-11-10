import { describe, expect, it } from "@effect/vitest";
import { createPetDecoder, MAX_PET_LINE_BYTES } from "./PetProtocol.ts";
import { DesktopPetProjection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

describe("native pet protocol", () => {
  it("decodes fragmented events and rejects unknown authority fields", () => {
    const events: unknown[] = [];
    const receive = createPetDecoder((event) => events.push(event));
    const line = JSON.stringify({
      v: 1,
      type: "state",
      visible: true,
      persistent: false,
      monitor: null,
      computerUse: null,
    });
    receive(Buffer.from(line.slice(0, 11)));
    expect(events).toEqual([]);
    receive(Buffer.from(`${line.slice(11)}\n`));
    expect(events).toHaveLength(1);
    expect(() =>
      receive(Buffer.from('{"v":1,"type":"action","id":"token","action":"approve"}\n')),
    ).toThrow();
    expect(() =>
      createPetDecoder(() => {})(
        Buffer.from('{"v":1,"type":"action","id":"token","action":"open","payload":"secret"}\n'),
      ),
    ).toThrow();
  });
  it("bounds unterminated native output and rejects unconfirmed privacy values", () => {
    const receive = createPetDecoder(() => {});
    expect(() => receive(Buffer.alloc(MAX_PET_LINE_BYTES + 1, 120))).toThrow();
    expect(() =>
      createPetDecoder(() => {})(
        Buffer.from(
          JSON.stringify({
            v: 1,
            type: "state",
            visible: true,
            persistent: false,
            monitor: null,
            computerUse: { observationMode: "private" },
          }) + "\n",
        ),
      ),
    ).toThrow();
  });
  it("accepts bounded concrete summaries without accepting extra payload or control fields", () => {
    const decode = Schema.decodeUnknownSync(DesktopPetProjection, { onExcessProperty: "error" });
    const projection = {
      v: 1,
      type: "projection",
      revision: 2,
      workingCount: 1,
      items: [
        { id: "opaque", kind: "question", summary: "Thread 2 · Question: Use the dark theme?" },
      ],
    };
    expect(decode(projection)).toEqual(projection);
    for (const summary of ["", " ", "x".repeat(241), "hidden\ntext", "hidden\u202etext"])
      expect(() =>
        decode({ ...projection, items: [{ ...projection.items[0], summary }] }),
      ).toThrow();
    expect(() => decode({ ...projection, observationActive: true })).toThrow();
    expect(() =>
      decode({ ...projection, items: [{ ...projection.items[0], payload: "secret" }] }),
    ).toThrow();
  });
});

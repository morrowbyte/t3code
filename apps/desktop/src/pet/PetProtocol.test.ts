import { describe, expect, it } from "@effect/vitest";
import { createPetDecoder, MAX_PET_LINE_BYTES } from "./PetProtocol.ts";

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
});

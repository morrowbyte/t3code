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
  it("accepts negotiated built-in characters and rejects invalid selection claims", () => {
    const events: unknown[] = [];
    const ready = {
      v: 1,
      type: "ready",
      capabilities: {
        nativeOverlay: true,
        focusMonitor: true,
        customPet: true,
        computerUse: true,
        builtinPets: [{ species: "weasel", name: "sudo" }],
      },
    };
    const state = {
      v: 1,
      type: "state",
      visible: true,
      persistent: false,
      monitor: null,
      computerUse: null,
      character: {
        source: "builtin",
        requestedSpecies: "weasel",
        species: "weasel",
        name: "sudo",
      },
    };
    const receive = createPetDecoder((event) => events.push(event));
    receive(Buffer.from(`${JSON.stringify(ready)}\n${JSON.stringify(state)}\n`));
    expect(events).toEqual([ready, state]);
    for (const character of [
      { source: "unavailable", requestedSpecies: "cat", species: null, name: null },
      { source: "custom", requestedSpecies: "cat", species: null, name: "My pet" },
    ]) {
      expect(() =>
        createPetDecoder(() => {})(Buffer.from(`${JSON.stringify({ ...state, character })}\n`)),
      ).not.toThrow();
    }
    for (const character of [
      { ...state.character, species: "dragon" },
      { ...state.character, requestedSpecies: "cat" },
      { ...state.character, source: "unavailable" },
      { ...state.character, name: "hidden\u202etext" },
      { ...state.character, source: "custom" },
      { ...state.character, path: "/private" },
    ]) {
      expect(() =>
        createPetDecoder(() => {})(Buffer.from(`${JSON.stringify({ ...state, character })}\n`)),
      ).toThrow();
    }
    for (const builtinPets of [
      [{ species: "dragon", name: "Unrecognized" }],
      [
        { species: "cat", name: "Cat" },
        { species: "cat", name: "Other cat" },
      ],
      [{ species: "weasel", name: "sudo", path: "/private" }],
    ]) {
      expect(() =>
        createPetDecoder(() => {})(
          Buffer.from(
            `${JSON.stringify({ ...ready, capabilities: { ...ready.capabilities, builtinPets } })}\n`,
          ),
        ),
      ).toThrow();
    }
  });
});

import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { WindowsCuaStatus } from "./windowsCua.ts";

const decode = Schema.decodeUnknownSync(WindowsCuaStatus);
const status = {
  environmentId: "windows-target",
  supported: true,
  enabled: true,
  phase: "ready",
  ownerThreadId: "thread-one",
};

it.each(["disabled", "idle", "ready", "failed"])(
  "defaults an older server's %s input phase to unknown",
  (phase) => {
    expect(decode({ ...status, phase })).toMatchObject({ inputPhase: "unknown" });
  },
);

it.each(["unknown", "active", "released"])(
  "preserves the reported %s input phase",
  (inputPhase) => {
    expect(decode({ ...status, inputPhase })).toMatchObject({ inputPhase });
  },
);

it("rejects an invalid input phase instead of accepting a false release", () => {
  expect(() => decode({ ...status, inputPhase: "idle" })).toThrow();
});

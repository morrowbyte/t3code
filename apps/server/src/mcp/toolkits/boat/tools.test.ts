import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BoatToolkit } from "./tools.ts";

it("requires an explicit duration only for MCP operations that extend a VM's running time", () => {
  const decode = Schema.decodeUnknownSync(BoatToolkit.tools.boat_environment.parametersSchema);
  const target = { projectId: "project-demo", requestId: "vm-demo" };
  for (const action of ["start", "resume", "renew"]) {
    assert.throws(() => decode({ request: { ...target, action } }));
    assert.throws(() => decode({ request: { ...target, action, ttlMinutes: 0 } }));
    const { request } = decode({ request: { ...target, action, ttlMinutes: 60 } });
    assert.equal("ttlMinutes" in request ? request.ttlMinutes : undefined, 60);
  }
  for (const action of ["stop", "delete", "prepare", "preview"]) {
    assert.equal(decode({ request: { ...target, action } }).request.action, action);
  }
  assert.equal(
    decode({ request: { ...target, action: "exec", command: "printf ok" } }).request.action,
    "exec",
  );
});

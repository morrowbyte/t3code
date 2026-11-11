// @effect-diagnostics nodeBuiltinImport:off -- This real subprocess test owns and removes its isolated executable fixture.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DEFAULT_DESKTOP_PET_SETTINGS } from "@t3tools/contracts";
import { PetCompanion } from "./PetCompanion.ts";

it("preserves the latest projection across reconnect and clears it on renderer reload", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pet-protocol-"));
  const executable = NodePath.join(directory, "companion");
  await NodeFSP.writeFile(
    executable,
    `#!/usr/bin/env node
const send = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
send({v:1,type:'ready',capabilities:{nativeOverlay:true,focusMonitor:true,customPet:true,computerUse:true}});
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\\n'); pending = lines.pop();
  for (const line of lines) {
    const message = JSON.parse(line);
    if (message.type === 'shutdown') process.exit(0);
    if (message.type === 'projection') send({v:1,type:'state',visible:true,persistent:false,monitor:process.pid + ':revision-' + message.revision + ':items-' + message.items.map(item => item.id).join(','),computerUse:null});
  }
});
`,
    { mode: 0o700 },
  );
  let onEvent = () => {};
  const pet = new PetCompanion(NodePath.join(directory, "state"), () => {
    onEvent();
  });
  const untilRevision = (revision: number, previousMonitor?: string | null) =>
    new Promise<void>((resolve) => {
      onEvent = () => {
        if (
          pet.status.native?.monitor?.includes(`:revision-${revision}:`) &&
          pet.status.native.monitor !== previousMonitor
        )
          resolve();
      };
      onEvent();
    });
  try {
    await pet.configure({ ...DEFAULT_DESKTOP_PET_SETTINGS, executable });
    await untilRevision(0);
    pet.setProjection({
      v: 1,
      type: "projection",
      revision: 1,
      workingCount: 0,
      items: [{ id: "opaque", kind: "question", summary: "An agent has a question for you." }],
    });
    await untilRevision(1);
    const previousMonitor = pet.status.native?.monitor;
    await pet.reconnect();
    await untilRevision(1, previousMonitor);
    expect(pet.status.native?.monitor).not.toBe(previousMonitor);
    expect(pet.status.native?.monitor).toContain(":items-opaque");
    pet.resetProjection();
    await untilRevision(2);
    pet.setProjection({ v: 1, type: "projection", revision: 1, workingCount: 0, items: [] });
    await untilRevision(3);
    expect(pet.status.native?.computerUse).toBeNull();
    expect(pet.status.settings.persistent).toBe(false);
  } finally {
    pet.stop();
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

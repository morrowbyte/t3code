// @effect-diagnostics nodeBuiltinImport:off -- This real subprocess test owns and removes its isolated executable fixture.
import { expect, it } from "@effect/vitest";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { DEFAULT_DESKTOP_PET_SETTINGS, type DesktopPetEvent } from "@t3tools/contracts";
import { PetCompanion } from "./PetCompanion.ts";

it("clears native items across renderer reload with monotone wire revisions", async () => {
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
    if (message.type === 'projection') send({v:1,type:'state',visible:true,persistent:false,monitor:'revision-' + message.revision,computerUse:null});
  }
});
`,
    { mode: 0o700 },
  );
  const events: DesktopPetEvent[] = [];
  let onEvent = () => {};
  const pet = new PetCompanion(NodePath.join(directory, "state"), (event) => {
    events.push(event);
    onEvent();
  });
  const untilRevision = (revision: number) =>
    new Promise<void>((resolve) => {
      onEvent = () => {
        if (
          events.some(
            (event) =>
              event.type === "status" && event.status.native?.monitor === `revision-${revision}`,
          )
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

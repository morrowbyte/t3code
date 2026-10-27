import { describe, expect, it } from "vite-plus/test";
import { presentPendingBackgroundWork } from "./threadExecution.ts";
import { ProviderDriverKind, TurnItemId } from "@t3tools/contracts";

describe("background command presentation", () => {
  it("keeps the complete wrapper separate from the recognizable command", () => {
    const command =
      "/bin/bash -lc 'umask 077; PATH=/bin vp run dev --port 14664 > /tmp/private.log 2>&1'";
    const presentation = presentPendingBackgroundWork([
      { taskId: "dev", kind: "command", description: command },
      { taskId: "other", kind: "command", description: "unknown-tool --watch /work" },
    ]);
    expect(presentation?.items.map(({ commandLabel }) => commandLabel)).toEqual([
      "vp run dev",
      "unknown-tool --watch /work",
    ]);
    expect(presentation?.items[0]?.commandLine).toBe(command);
    expect(presentation?.waiting).toBe(false);
    expect(presentPendingBackgroundWork([])).toBeNull();
  });

  it("uses actual command input rather than a friendly provider title when available", () => {
    const original = "bash -lc 'sleep 600 > /tmp/owned.log 2>&1'";
    const item = {
      id: TurnItemId.make("test-command"),
      type: "command_execution" as const,
      input: original,
      status: "waiting" as const,
      nativeItemRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "native-command",
        strength: "strong" as const,
      },
    };
    const presentation = presentPendingBackgroundWork(
      [{ taskId: "native-command", kind: "command", description: "A friendly title" }],
      [item],
    );
    expect(presentation?.items[0]).toMatchObject({
      commandLabel: "sleep 600",
      commandLine: original,
      commandStatus: "waiting",
    });
  });

  it("uses the semantic item title while retaining the exact shell input", () => {
    const command = "/bin/bash -lc \"python3 - <<'PY'\nprint('original')\nPY\"";
    const presentation = presentPendingBackgroundWork(
      [{ taskId: "python", kind: "command", description: command }],
      [
        {
          id: TurnItemId.make("python"),
          type: "command_execution",
          nativeItemRef: null,
          input: command,
          title: "Inspect recording permission preferences",
          status: "running",
        },
      ],
    );
    expect(presentation?.items[0]).toMatchObject({
      commandLabel: "Inspect recording permission preferences",
      commandLine: command,
      commandStatus: "running",
    });
  });
});

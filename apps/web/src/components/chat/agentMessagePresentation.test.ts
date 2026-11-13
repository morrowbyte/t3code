import {
  MessageId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";
import {
  loadReplyHistory,
  replyMessageFromLocation,
  replyThreadSnapshot,
} from "./useAgentReplyNavigation";

import {
  agentMessagePreview,
  agentDelegationText,
  collapsedAgentMessageSummary,
  parseAgentMessage,
  readAgentSend,
} from "./agentMessagePresentation";

describe("agent reply navigation", () => {
  const target = { environmentId: "original-environment", threadId: "original-thread" };
  const settled = {
    thread: null,
    threadId: target.threadId,
    messageId: "original-message",
    status: "live",
    error: null,
    history: {
      historyCursor: null,
      hasMoreHistory: false,
      loading: false,
      error: null,
      expanded: false,
      latestLocalTurnOrdinal: null,
    },
  } satisfies Parameters<typeof replyThreadSnapshot>[0];

  it("retains the exact message selector only in its original environment and thread", () => {
    const href = "/original-environment/original-thread?messageId=original-message";
    expect(replyMessageFromLocation(href, target)).toBe("original-message");
    expect(replyMessageFromLocation(href, { ...target, environmentId: "other" })).toBeNull();
    expect(replyMessageFromLocation(href, { ...target, threadId: "other" })).toBeNull();
    expect(replyMessageFromLocation("/original-environment/original-thread", target)).toBeNull();
  });

  it.each([0, 2])("reaches the original after %i history pages", async (pages) => {
    let loads = 0;
    const outcome = await loadReplyHistory({
      signal: new AbortController().signal,
      readThread: async () => ({ found: loads === pages, hasMoreHistory: true }),
      loadThrough: async () => {
        loads += 1;
        return { _tag: "loaded" };
      },
    });
    expect(outcome).toBe("found");
    expect(loads).toBe(pages);
  });

  it.each(["error", "noop"] as const)(
    "reports an unreachable original on %s without a fallback target",
    async (_tag) => {
      await expect(
        loadReplyHistory({
          signal: new AbortController().signal,
          readThread: async () => ({ found: false, hasMoreHistory: true }),
          loadThrough: async () => ({ _tag }),
        }),
      ).resolves.toBe(_tag === "error" ? "failed" : "unavailable");
    },
  );

  it("finds a textless paged user message by its original thread and message IDs", () => {
    const item: OrchestrationV2TurnItem = {
      ...tool(),
      threadId: ThreadId.make(target.threadId),
      type: "user_message",
      messageId: MessageId.make(settled.messageId),
      text: "",
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mcp",
    };
    const visibleTurnItems: NonNullable<
      Parameters<typeof replyThreadSnapshot>[0]["thread"]
    >["projection"]["visibleTurnItems"] = [
      {
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
        position: 0,
        visibility: "local",
        item,
      },
    ];
    const thread = {
      projection: { visibleTurnItems },
    } as NonNullable<Parameters<typeof replyThreadSnapshot>[0]["thread"]>;
    expect(replyThreadSnapshot({ ...settled, thread })).toEqual({
      found: true,
      hasMoreHistory: false,
    });
    expect(replyThreadSnapshot({ ...settled, thread, threadId: "other-thread" })?.found).toBe(
      false,
    );
    expect(replyThreadSnapshot({ ...settled, thread, messageId: "other-message" })?.found).toBe(
      false,
    );
    expect(replyThreadSnapshot({ ...settled, thread, unreachable: true })?.found).toBe(true);
  });

  it.each([
    { status: "deleted", expected: "unavailable" },
    { error: "Thread not found", expected: "failed" },
    { unreachable: true, expected: "failed" },
  ] as const)(
    "settles a missing or offline original: $expected",
    async ({ expected, ...state }) => {
      await expect(
        loadReplyHistory({
          signal: new AbortController().signal,
          readThread: async () => replyThreadSnapshot({ ...settled, ...state }),
          loadThrough: async () => {
            throw new Error("Must not load an unavailable original");
          },
        }),
      ).resolves.toBe(expected);
    },
  );

  it("does not navigate after leaving the reply while history loads", async () => {
    const controller = new AbortController();
    await expect(
      loadReplyHistory({
        signal: controller.signal,
        readThread: async () => ({ found: false, hasMoreHistory: true }),
        loadThrough: async () => {
          controller.abort();
          return { _tag: "loaded" };
        },
      }),
    ).resolves.toBe("aborted");
  });

  it("bounds history loads when the original cannot be reached", async () => {
    let loads = 0;
    await expect(
      loadReplyHistory({
        signal: new AbortController().signal,
        readThread: async () => ({ found: false, hasMoreHistory: true }),
        loadThrough: async () => {
          loads += 1;
          return { _tag: "loaded" };
        },
      }),
    ).resolves.toBe("failed");
    expect(loads).toBe(20);
  });
});

it("keeps long task cards concise without changing the authored task", () => {
  const task = `Beendete Gespräche mit ihren Transkripten wieder öffnen. ${"Interne technische Details mit vielen Vorgaben. ".repeat(30)}`;
  expect(collapsedAgentMessageSummary(task)).toBe(
    "Beendete Gespräche mit ihren Transkripten wieder öffnen.",
  );
  expect(agentMessagePreview(task)).toBe(task.trim());
  const unbroken = "🦦".repeat(300);
  expect(collapsedAgentMessageSummary(unbroken)).toBe(`${"🦦".repeat(220)}…`);
});

it("shows the complete authored first paragraph, including wrapped lines and long sentences", () => {
  const opening = `Prüfe die Agentennachrichten mit VK Birkenborn.\r\n${"Der Kurzauftrag bleibt vollständig sichtbar. ".repeat(8).trim()}`;
  expect(agentMessagePreview(`\r\n${opening}\r\n \t\r\nTechnik: ausführlicher Auftrag`)).toBe(
    opening,
  );
});

describe("parseAgentMessage", () => {
  it.each([
    "Kurz: Lesbar.",
    "**Kurz:** Lesbar.",
    "**Kurz**: Lesbar.",
    "## Kurz\n\nLesbar.",
    "Summary: Lesbar.",
  ])("requires a sender-authored summary: %s", (text) => {
    expect(parseAgentMessage(text)).toEqual({
      kind: "structured",
      summary: "Lesbar.",
      status: null,
      sections: [],
    });
  });

  it("keeps Unicode, bullets and unknown section content without changing the source", () => {
    const original =
      "\r\n**Kurz:** Upload geprüft; Transkription offen. 🦦\r\n\r\nStatus: blockiert\r\n\r\n**Geprüft:**\r\n- Aufnahme → Upload\r\n- Fehleranzeige geprüft\r\n\r\n## Offen\r\nZugang benötigt.\r\n\r\nArtefakte: prüfung.md\r\nWeitere Datei: ergebnis.json";
    const before = original;
    expect(parseAgentMessage(original)).toEqual({
      kind: "structured",
      summary: "Upload geprüft; Transkription offen. 🦦",
      status: "blockiert",
      sections: [
        { kind: "result", label: "Geprüft", text: "- Aufnahme → Upload\n- Fehleranzeige geprüft" },
        { kind: "open", label: "Offen", text: "Zugang benötigt." },
        { kind: "detail", label: "Artefakte", text: "prüfung.md" },
        { kind: "detail", label: "Weitere Datei", text: "ergebnis.json" },
      ],
    });
    expect(original).toBe(before);
  });

  it.each(["```text", "~~~text"])("does not interpret headings inside %s fences", (fence) => {
    const close = fence.slice(0, 3);
    const technical = `${fence}\nStatus: fertig\nOffen: keine\n**Kurz:** kein neuer Titel\n${close}`;
    expect(
      parseAgentMessage(`Kurz: Account lehnt ab.\nTechnik:\n${technical}\nOffen: Transkription.`),
    ).toEqual({
      kind: "structured",
      summary: "Account lehnt ab.",
      status: null,
      sections: [
        { kind: "technical", label: "Technik", text: technical },
        { kind: "open", label: "Offen", text: "Transkription." },
      ],
    });
  });

  it("keeps technical label-value prose inside its disclosure", () => {
    const technical =
      "Bestehender Nachrichtentext beginnt Kurz: Ein Satz.\nProps: text, direction.";
    expect(
      parseAgentMessage(`Kurz: Vorlage bereit.\nTechnik:\n${technical}\nOffen: Sichtcheck.`),
    ).toEqual({
      kind: "structured",
      summary: "Vorlage bereit.",
      status: null,
      sections: [
        { kind: "technical", label: "Technik", text: technical },
        { kind: "open", label: "Offen", text: "Sichtcheck." },
      ],
    });
  });

  it("maps only the declared section headings", () => {
    expect(
      parseAgentMessage(
        "Kurz: Ein Befund.\nErgebnis: Eins.\nNächster Schritt: Zwei.\nEntscheidung: Drei.\nDetails: Vier.",
      ).sections,
    ).toEqual([
      { kind: "result", label: "Ergebnis", text: "Eins." },
      { kind: "next", label: "Nächster Schritt", text: "Zwei." },
      { kind: "decision", label: "Entscheidung", text: "Drei." },
      { kind: "detail", label: "Details", text: "Vier." },
    ]);
  });

  it.each([
    "",
    "HTTP 403: BLOCKIERT",
    "Status: fertig\nAlles fertig.",
    "**Kurz: unvollständig",
    "Kurz:\nOffen: Etwas fehlt.",
    "## Kurzfassung\nFertig.",
  ])("leaves legacy or malformed input without a manufactured summary: %s", (text) => {
    expect(parseAgentMessage(text)).toEqual({
      kind: "legacy",
      summary: null,
      status: null,
      sections: [],
    });
  });

  it("never infers status from summary or technical prose", () => {
    const parsed = parseAgentMessage(
      "Kurz: Fertig, HTTP 403 bleibt blockiert.\nStatus: vielleicht fertig\nDetails: **Offen: kaputt",
    );
    expect(parsed.status).toBeNull();
    expect(parsed.sections).toEqual([
      { kind: "detail", label: "Status", text: "vielleicht fertig" },
      { kind: "detail", label: "Details", text: "**Offen: kaputt" },
    ]);
  });

  it("preserves conflicting explicit statuses as details", () => {
    const parsed = parseAgentMessage("Kurz: Widerspruch.\nStatus: fertig\nStatus: blockiert");
    expect(parsed.status).toBeNull();
    expect(parsed.sections).toEqual([
      { kind: "detail", label: "Status", text: "fertig" },
      { kind: "detail", label: "Status", text: "blockiert" },
    ]);
  });

  it.each(["info", "fertig", "blockiert", "frage", "entscheidung"])(
    "accepts the explicit status token %s",
    (status) => {
      expect(parseAgentMessage(`Kurz: Ein Befund.\n**Status:** ${status}`).status).toBe(status);
    },
  );
});

type DynamicTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

function tool(overrides: Partial<DynamicTool> = {}): DynamicTool {
  return {
    id: "tool-item" as DynamicTool["id"],
    threadId: "source" as DynamicTool["threadId"],
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-10-18T13:36:36.809Z"),
    type: "dynamic_tool",
    toolName: "t3-code.t3_thread_send",
    input: { threadId: "target", message: "Kurz: Aufnahme geprüft. 🦦\n\nOffen:\n- Transkription" },
    output: { threadId: "target", messageId: "message-1", delivery: "steered", status: "running" },
    ...overrides,
  };
}

describe("readAgentSend", () => {
  it("retains a cross-thread reply without moving the original question into the destination", () => {
    const replyTo = {
      environmentId: "remote",
      threadId: "source-question-thread",
      messageId: "question",
    };
    expect(
      readAgentSend(tool({ input: { threadId: "target", message: "Kurz: Antwort.", replyTo } })),
    ).toMatchObject({ replyTo });
    for (const invalid of [
      "question",
      { messageId: "question" },
      { ...replyTo, environmentId: " " },
    ]) {
      expect(
        readAgentSend(
          tool({ input: { threadId: "target", message: "Kurz: Antwort.", replyTo: invalid } }),
        ).replyTo,
      ).toBeNull();
    }
  });

  it.each([
    { threadId: "target", message: "Kurz: Antwort.", environmentId: "remote" },
    JSON.stringify({
      toolName: "t3_thread_send",
      args: { threadId: "target", message: "Kurz: Antwort.", environmentId: "remote" },
    }),
  ])("retains the explicit destination environment for ordinary remote sends", (input) => {
    expect(readAgentSend(tool({ input }))).toMatchObject({
      targetThreadId: "target",
      targetEnvironmentId: "remote",
      targetScope: "explicit",
      accepted: true,
    });
  });

  it("keeps legacy local sends local and summarized destinations unknown", () => {
    expect(readAgentSend(tool())).toMatchObject({
      targetEnvironmentId: null,
      targetScope: "local",
    });
    expect(
      readAgentSend(tool({ input: { summary: "Large tool input", truncated: true } })),
    ).toMatchObject({ targetThreadId: "target", targetScope: "unknown" });
  });

  it.each([
    { threadId: "target", messageId: "message-1", environmentId: "remote" },
    {
      type: "relay",
      result: {
        type: "send",
        result: { threadId: "target", messageId: "message-1", environmentId: "remote" },
      },
    },
    { threadId: "target", messageId: "message-1", link: "<t3-thread://v2/remote/target>" },
    { threadId: "target", messageId: "message-1", link: "https://crew.example/remote/target" },
    {
      type: "send",
      result: {
        threadId: "target",
        messageId: "message-1",
        link: "<t3-thread://v2/remote/target>",
      },
    },
  ])("recovers exact remote destinations from bounded send receipts", (output) => {
    expect(
      readAgentSend(tool({ input: { summary: "Large tool input", truncated: true }, output })),
    ).toMatchObject({
      targetThreadId: "target",
      targetEnvironmentId: "remote",
      targetScope: "explicit",
      accepted: true,
      text: null,
    });
  });

  it("rejects conflicting environments and does not guess from malformed provenance", () => {
    expect(
      readAgentSend(
        tool({
          input: { threadId: "target", environmentId: "remote", message: "Kurz: Antwort." },
          output: {
            threadId: "target",
            messageId: "message-1",
            link: "<t3-thread://v2/other/target>",
          },
        }),
      ),
    ).toMatchObject({ targetEnvironmentId: "remote", accepted: false, failed: true });
    expect(
      readAgentSend(
        tool({
          input: { threadId: "target", environmentId: " ", message: "Kurz: Antwort." },
        }),
      ),
    ).toMatchObject({ targetScope: "unknown" });
  });

  it.each(["accepted", "steered"])(
    "reads %s receipts and preserves the exact outbound text",
    (delivery) => {
      const text = " \r\nKurz: Maßnahme geprüft. 🦦\r\n\r\nDetails: üöä\r\n ";
      const item = tool({
        input: { threadId: "target", message: text },
        output: { threadId: "target", messageId: "message-1", delivery, status: "running" },
      });
      expect(readAgentSend(item)).toEqual({
        targetThreadId: "target",
        targetEnvironmentId: null,
        targetScope: "local",
        replyTo: null,
        text,
        delivery,
        accepted: true,
        failed: false,
        truncated: false,
      });
      expect(item.input).toEqual({ threadId: "target", message: text });
    },
  );

  it.each([
    { threadId: "target", messageId: "message-1", delivery: "queued" },
    { structuredContent: { threadId: "target", messageId: "message-1", delivery: "queued" } },
    [{ type: "text", text: '{"threadId":"target","messageId":"message-1","delivery":"queued"}' }],
    {
      content: [
        { text: { text: '{"threadId":"target","messageId":"message-1","delivery":"queued"}' } },
      ],
      isError: false,
    },
    '{"threadId":"target","messageId":"message-1","delivery":"queued"}',
  ])("reads bounded MCP receipt envelopes", (output) => {
    expect(readAgentSend(tool({ output }))).toMatchObject({
      accepted: true,
      failed: false,
      delivery: "queued",
    });
  });

  it.each(["t3_thread_send", "t3_connected_thread_send"])(
    "reads %s JSON input and Cursor's args wrapper",
    (toolName) => {
      const text =
        '{"threadId":"prose-is-not-a-target","messageId":"not-a-receipt"}\n\nFull original. 🦦';
      const replyTo = {
        environmentId: "origin",
        threadId: "question-thread",
        messageId: "question",
      };
      const args = { environmentId: "remote", threadId: "target", message: text, replyTo };
      for (const name of [
        toolName,
        `mcp__t3_code__${toolName}`,
        `t3-code.${toolName}`,
        `t3-code-thread_with_underscores_${toolName}`,
      ]) {
        for (const input of [args, JSON.stringify({ toolName, args })]) {
          expect(readAgentSend(tool({ toolName: name, input }))).toMatchObject({
            targetThreadId: "target",
            targetEnvironmentId: "remote",
            targetScope: "explicit",
            replyTo,
            text,
            delivery: "steered",
            accepted: true,
            failed: false,
          });
        }
      }
      if (toolName === "t3_connected_thread_send") {
        for (const input of [
          { threadId: "target", message: text },
          { ...args, environmentId: " " },
        ]) {
          expect(readAgentSend(tool({ toolName, input }))).toMatchObject({
            targetEnvironmentId: null,
            targetScope: "unknown",
          });
        }
      }
    },
  );

  it("does not recognize tool names or receipts embedded in unrelated prose", () => {
    expect(
      readAgentSend(
        tool({
          toolName: "functions.exec",
          input: { threadId: "target", message: "t3_thread_send" },
        }),
      ),
    ).toEqual({
      targetThreadId: null,
      targetEnvironmentId: null,
      targetScope: "unknown",
      replyTo: null,
      text: null,
      delivery: null,
      accepted: false,
      failed: false,
      truncated: false,
    });
    expect(
      readAgentSend(
        tool({
          input: { threadId: "target", message: '{"threadId":"fake","messageId":"fake"}' },
          output: undefined,
        }),
      ),
    ).toMatchObject({ targetThreadId: "target", accepted: false, delivery: null });
  });

  it("requires receipt identity rather than tool completion or a delivery word", () => {
    for (const output of [
      undefined,
      "Message sent",
      { delivery: "started" },
      { threadId: "target" },
      { messageId: "message-1" },
    ]) {
      expect(readAgentSend(tool({ output }))).toMatchObject({ accepted: false, delivery: null });
    }
  });

  it("keeps compact receipt acceptance without inventing delivery", () => {
    expect(
      readAgentSend(
        tool({ outputOmitted: true, output: { threadId: "target", messageId: "message-1" } }),
      ),
    ).toMatchObject({ accepted: true, delivery: null, truncated: false });
  });

  it("rejects mismatched destinations even when both identities look valid", () => {
    expect(
      readAgentSend(
        tool({ output: { threadId: "other", messageId: "message-1", delivery: "started" } }),
      ),
    ).toMatchObject({ targetThreadId: "target", accepted: false, failed: true, delivery: null });
  });

  it("treats MCP errors returned as data as failure despite completed tool status", () => {
    const receipt = { threadId: "target", messageId: "message-1", delivery: "started" };
    for (const output of [
      { ...receipt, delivery: "failed", status: "running" },
      { structuredContent: { ...receipt, delivery: "failed", status: "running" } },
      { isError: true, structuredContent: receipt },
      {
        content: [
          { text: JSON.stringify(receipt) },
          { text: '{"_tag":"OrchestratorMcpFailure","message":"Denied"}' },
        ],
      },
    ]) {
      expect(readAgentSend(tool({ output }))).toMatchObject({
        accepted: false,
        failed: true,
        delivery: null,
      });
    }
  });

  it("rejects a failed tool lifecycle even when receipt data is present", () => {
    expect(readAgentSend(tool({ status: "failed" }))).toMatchObject({
      accepted: false,
      failed: true,
      delivery: null,
    });
  });

  it("does not expose a summarized input as the original message", () => {
    expect(
      readAgentSend(
        tool({
          input: { threadId: "target", message: "prefix\n… output truncated for transport" },
        }),
      ),
    ).toMatchObject({ text: null, truncated: true });
    expect(
      readAgentSend(tool({ input: { summary: "Large tool input", truncated: true } })),
    ).toEqual({
      targetThreadId: "target",
      targetEnvironmentId: null,
      targetScope: "unknown",
      replyTo: null,
      text: null,
      delivery: "steered",
      accepted: true,
      failed: false,
      truncated: true,
    });
  });

  it("bounds malformed, oversized and cyclic envelopes", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.content = cyclic;
    expect(readAgentSend(tool({ output: cyclic }))).toMatchObject({
      accepted: false,
      truncated: true,
    });
    expect(readAgentSend(tool({ input: "x".repeat(256 * 1024 + 1) }))).toMatchObject({
      text: null,
      truncated: true,
    });
    expect(readAgentSend(tool({ output: "{truncated" }))).toMatchObject({
      accepted: false,
      delivery: null,
    });
  });
});

describe("agentDelegationText", () => {
  it("keeps the complete initial task instead of substituting its preview", () => {
    const prompt =
      "Kurz: Prüfe den Auftrag.\r\n\r\nTechnik:\r\n- Vollständige Abnahme\r\n- Rückweg prüfen\r\n";
    const item = {
      ...tool(),
      type: "subagent" as const,
      subagentId: "task" as Extract<OrchestrationV2TurnItem, { type: "subagent" }>["subagentId"],
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: "codex" as Extract<
        OrchestrationV2TurnItem,
        { type: "subagent" }
      >["providerInstanceId"],
      childThreadId: null,
      prompt,
      result: null,
      delegationMessage: {
        messageId: "initial" as import("@t3tools/contracts").MessageId,
        firstParagraph: "Kurz: Prüfe den Auftrag.",
      },
    };
    expect(agentDelegationText(item)).toBe(prompt);
    expect(agentDelegationText({ ...item, promptOmitted: true })).toBeNull();
    expect(agentDelegationText({ ...item, prompt: "" })).toBeNull();
    expect(
      agentDelegationText({ ...item, prompt: "prefix\n… output truncated for transport" }),
    ).toBeNull();
  });
});

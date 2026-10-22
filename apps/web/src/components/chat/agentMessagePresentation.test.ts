import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { agentMessagePreview, parseAgentMessage, readAgentSend } from "./agentMessagePresentation";

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
  it("reads actual structured calls and preserves the exact outbound text", () => {
    const text = " \r\nKurz: Maßnahme geprüft. 🦦\r\n\r\nDetails: üöä\r\n ";
    const item = tool({ input: { threadId: "target", message: text } });
    expect(readAgentSend(item)).toEqual({
      targetThreadId: "target",
      text,
      delivery: "steered",
      accepted: true,
      failed: false,
      truncated: false,
    });
    expect(item.input).toEqual({ threadId: "target", message: text });
  });

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

  it("reads JSON input and Cursor's args wrapper", () => {
    const text = '{"threadId":"prose-is-not-a-target","messageId":"not-a-receipt"}';
    expect(
      readAgentSend(
        tool({
          toolName: "mcp__t3_code__t3_thread_send",
          input: JSON.stringify({
            toolName: "t3_thread_send",
            args: { threadId: "target", message: text },
          }),
        }),
      ),
    ).toMatchObject({ targetThreadId: "target", text, accepted: true });
  });

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
      readAgentSend(tool({ input: { summary: "Large tool input", truncated: true } })),
    ).toEqual({
      targetThreadId: "target",
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

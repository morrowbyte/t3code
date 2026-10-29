import type { ProviderInteractionMode } from "@t3tools/contracts";

const T3_CODE_ORCHESTRATION_CONTROL_INSTRUCTIONS = `

## T3 Code orchestration

The \`t3-code\` MCP server provides app-owned orchestration. Treat these concepts distinctly:

- Keep your thread title useful without waiting for the user to ask. When a placeholder title or a meaningful change in the task makes the current title misleading, use \`t3_thread_update\` with \`action:"rename"\` and a concise title in the user's language; omit \`threadId\` for your own thread. Apply the same judgment to your direct delegated child threads when their scope changes. Preserve explicit user naming preferences, avoid renaming for routine progress or every turn, and do not start extra work or model calls just to decide a title.
- Call \`orchestrator_capabilities\` once per thread before the first delegation or first inter-agent message through T3, and again after a capability error or a user-named provider change. If the result includes agentMessageContext, use it as optional voice guidance only for inter-agent messages; do not copy the profile into messages or change facts, status, tool or safety rules. A later result without agentMessageContext disables any earlier voice guidance. A delegated task/subagent is child work owned by the current thread. Use \`orchestrator_capabilities\` to discover the current provider/model IDs from the same live catalog as the composer, including configured custom models. It lists a short set of models per provider; pass \`search\` to find others. Do not treat a native tool's model list as the full list of available subagent models. Prefer native subagent tools for same-provider work only when they support the chosen model and no model options are requested or inherited. Use \`delegate_task\` with that provider instance and model when native tools cannot, including for same-provider work. Also use \`delegate_task\` for cross-provider or explicitly T3-owned child tasks. For a child task that needs a separate checkout, use \`delegate_task\` with \`isolation:"worktree"\` across any provider or model. It starts from the parent local commit and runs project setup; uncommitted edits are not copied. Retain each returned \`taskId\`, and use \`task_status\` or \`task_cancel\` to manage it. The returned \`childThreadId\` is backing storage for the subagent, not the target for starting another delegated review round.
- \`t3_thread_launch\` and \`create_threads\` create ordinary top-level T3 conversations. Use them only when the user explicitly asks for separate/new/top-level threads or conversations. Never use them merely because the user said "subagent" or requested parallel delegated work.
- For every T3 delegated review round, call \`delegate_task\` again. Include the original brief, prior findings, responses, and unresolved objections in each new task prompt. Track each round by its own \`taskId\`. Use a distinct \`clientRequestId\` per round, stable across retries of that round. Do not use \`t3_thread_send\` on \`childThreadId\` to continue a delegated review.
- Follow a running delegate's returned \`next\` instruction. Do not poll with \`task_status\`, sleeps, watchers, or schedules. Cancel replaced or unnecessary delegates with \`task_cancel\`, including when the user asks to run fewer.
- \`schedule_task\` creates persistent recurring work in the app scheduler. Pass \`schedule\` as a structured object, never as JSON text: \`{"type":"interval","everyMs":3600000}\` for an interval, or \`{"type":"fixed_time","timeOfDay":"09:00","weekdays":[1,2,3,4,5]}\` for a wall-clock schedule, or \`{"type":"webhook"}\` to run on each request to the returned \`webhookUrl\` (the run sees the request only through \`{{body.path}}\`-style placeholders in the prompt). By default runs return to the current thread, which suits orchestrating: each trigger arrives here and you delegate or dedupe; set \`bindToCurrentThread=false\` only when the user wants a fresh thread for every run. When asked only to schedule, do not run its prompt now. After scheduling a timer, report the returned cadence and next run time; for a webhook, report its \`webhookUrl\`, or say T3 Connect remote access is needed if it is missing.
- When you need a secret from the user (a token, API key, or webhook signing secret), call \`request_secret\` so they enter it privately, then pass the returned \`secretRef\` to the tool that needs it, e.g. \`signature.secretRef\` on a webhook task for a sender that signs requests such as GitHub. A \`secretRef\` works once. Never ask for a secret in chat, never invent one, and never repeat one.
- To mention another thread to the user, link it as \`[title](t3-thread://v1/<threadId>)\` with its exact \`threadId\`, not URL-encoded. T3 Code opens the thread in the app and shows its current title.

- Before answering about a given thread, read it with \`t3_thread_read\`.
- For another machine, use \`t3_environment_links\` and pass its \`environmentId\` to tools targeting that machine. Thread and project IDs belong to that environment. If the named machine is not linked, call \`t3_environment_link\` with a \`hint\` from the user's words; never ask for a pairing code in chat. Use returned thread links verbatim.
- For a secret needed by a shell command, \`request_secret\` supports \`delivery:"file"\`; never put the secret in chat.

### Choose the workspace before starting a new thread

For independent implementation or a PR stack in its own worktree, use \`t3_thread_launch\` with an explicit \`workspaceStrategy\`. It creates or selects the workspace, binds the new thread to it, and prepares it before the agent starts. Put the task in \`message\`, not \`prompt\`:

- New worktree: \`{"title":"UI cleanup","workspaceStrategy":{"type":"worktree","baseRef":"feature/base","branch":"feature/ui-cleanup","startFromOrigin":false},"message":"Implement the cleanup and open a PR against feature/base."}\`
- Existing worktree: \`{"title":"Continue cleanup","workspaceStrategy":{"type":"existing_worktree","worktreePath":"/absolute/path/to/worktree","branch":"feature/ui-cleanup"},"message":"Continue the cleanup."}\`
- Project's main checkout: \`workspaceStrategy:{"type":"root"}\`. Omitting workspaceStrategy also selects root; it does not inherit the caller's worktree.

For stacked work, set \`baseRef\` to the intended parent branch and \`startFromOrigin:false\` to use its local commits. Use \`startFromOrigin:true\` when you intend to fetch the base branch's remote and start from it. Uncommitted edits are not copied. Use \`t3_worktree_list\` to discover existing checkout paths. Project, model selection, and modes inherit unless supplied; a launched thread may not run with broader modes than yours.

\`t3_thread_launch\` is the single-thread launch tool. Use \`create_threads\` only for a batch of threads intentionally sharing the caller's checkout: it always inherits the caller's project, branch, and worktree and has no workspace override. Asking an agent to run \`git worktree add\` or \`cd\` in its prompt does not update T3's thread binding. Select the workspace in the launch call instead. \`t3_worktree_handoff\` moves the calling thread, not another thread, and cannot move a thread already attached to a worktree.

\`t3_thread_launch\` has no idempotency key. Retain its returned threadId and inspect it with \`t3_thread_read\` / \`t3_thread_wait\`; preparation can still be running after acceptance. If a launch fails or its response is lost, inspect \`t3_thread_list\` before retrying, since a thread may already exist.

Tool names may include a harness-normalized MCP prefix, such as \`mcp__t3_code__delegate_task\`; the semantics are the same. Some harnesses attach optional MCP servers lazily: if an initial tool-catalog scan does not show T3 tools, do not conclude that cross-provider delegation is unavailable. Make one bounded direct attempt using the known T3 tool name on the next tool step. In Codex code mode, for example, call \`tools.mcp__t3_code__orchestrator_capabilities({})\` before reporting that the capability is absent. Keep polling/wait loops bounded, do not duplicate active work, and use stable \`clientRequestId\` values when retrying tools that accept them.

ACP fallback: some ACP agents accept the injected MCP server but fail to expose its tools. When the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call the same tools through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset when T3 runs as a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`. This is the supported T3 transport fallback, not an ordinary shell-based substitute for delegation.

- When model options are requested or the child keeps the parent's provider instance and model with nonempty \`inheritedOptions\` from \`orchestrator_capabilities\`, use \`delegate_task\` even for native-supported models. Native subagents cannot reliably apply T3 model options. Read the selected model's descriptors from \`orchestrator_capabilities\` and put settings in \`target.options\`, not only in the prompt. Claude commonly uses {"effort":"max","fastMode":true}; Codex uses {"reasoningEffort":"max","serviceTier":"priority"}. Do not translate max to high or ignore unsupported settings: report a capability mismatch. Options inherit only for the same provider instance and model; explicit entries override individual values, and [] or {} clears them. Check the returned providerInstanceId, model, and options against the requested selection.
`;

export const T3_CODE_VISUAL_INSTRUCTIONS = `### Showing visuals

Native inline visuals are available in assistant messages on web, desktop, and mobile. When useful, stream normal Markdown together with fenced \`t3-ui\` blocks containing JSON Lines: one complete JSON object per physical line, with no enclosing array or commas between records. Completed records render immediately, before the fence closes. This is Morrowbyte's bounded local component protocol, not OpenUI Lang. Only these records and fields are supported:
{"type":"metric","id":"summary","label":"Label","value":"123 USD","detail":"Optional explanation","sources":[{"label":"Source","url":"https://example.com"}]}
{"type":"table","id":"prices","title":"Daily closes","columns":["Date","Close (USD)"]}
{"type":"row","id":"prices","cells":["Day 1",123.45]}
{"type":"chart","id":"trend","title":"Daily closes","xLabel":"Date","yLabel":"USD"}
{"type":"point","id":"trend","label":"Day 1","value":123.45}
{"type":"chart","id":"comparison","title":"Plan and actual","kind":"bar","xLabel":"Week","yLabel":"Hours"}
{"type":"series","id":"comparison","key":"plan","label":"Plan"}
{"type":"series","id":"comparison","key":"actual","label":"Actual"}
{"type":"point","id":"comparison","series":"plan","label":"Week 1","value":20}
{"type":"point","id":"comparison","series":"actual","label":"Week 1","value":18}
{"type":"cards","id":"options","title":"Options"}
{"type":"card","id":"options","key":"small","title":"Small","value":"20 EUR","badge":"Starter","detail":"Optional detail"}
{"type":"fact","id":"options","item":"small","key":"capacity","label":"Capacity","value":2}
{"type":"timeline","id":"plan","title":"Plan"}
{"type":"event","id":"plan","key":"pilot","title":"Pilot","time":"Week 1","status":"active","detail":"Optional detail"}
{"type":"workflow","id":"flow","title":"Review"}
{"type":"node","id":"flow","key":"start","title":"Start","status":"complete"}
{"type":"node","id":"flow","key":"review","title":"Review"}
{"type":"edge","id":"flow","key":"next","from":"start","to":"review","label":"Ready"}
{"type":"report","id":"decision","title":"Decision","layout":"tabs"}
{"type":"section","id":"decision","key":"risks","title":"Risks","text":"Optional plain text"}
{"type":"fact","id":"decision","item":"risks","key":"budget","label":"Budget buffer","value":"7000 EUR"}
{"type":"uml","id":"request","title":"Request flow","kind":"sequence"}
{"type":"uml-snapshot","id":"request","key":"request-1","source":"@startuml\\nactor User\\nparticipant API\\nUser -> API: Request\\n@enduml"}
Declare each component once. IDs and item keys are 1-64 letters, digits, underscores or hyphens. Data records reference an already declared component by id; facts reference a prior card or report section by item; points reference a prior series by series; edges reference prior nodes by from/to. Append completed records as data becomes available. Never redeclare a component or keyed item. Chart kind is optional: "line" (default), "area", "bar", "pie", "donut", "radar", "radial", "scatter", or "composed". Choose a chart for a real comparison, trend, distribution or relationship. Bar supports horizontal:true; bar/area support stacked:true. Radar/radial may set maximum (for example 100 for percent). Pie/donut/radial use one value series; all polar values must be nonnegative. Scatter points require numeric x and use label for the sample name. Composed series may set kind:"bar", "area" or "line"; keep comparable units. Omit series for a legacy single-series chart; otherwise declare each series first and use its key on points. A series has at most one point per category label (per numeric x for scatter). Values at the same category share a tooltip. Users can copy all arrived chart data as CSV from View data. Choose comparable units within one chart. Reports use layout "tabs" or "details" (default). Status is optional: "pending", "active", "complete", or "blocked". Card value/badge/detail, event/node time/status/detail, edge label and section text are optional. Report text is plain text, not Markdown or HTML. Workflow nodes may set kind:"start", "step", "decision" or "end". UML kind is "sequence", "class", "state", "usecase" or "activity". Append uml-snapshot records with a unique key and a COMPLETE valid @startuml/@enduml PlantUML source string; escape newlines inside the JSON string. Each snapshot expands the diagram so far; do not send incomplete DSL fragments. Include proper UML notation: sequence lifelines/activations/alt/loop, class members/relations, state transitions, use-case actors/boundary/include/extend, activity branches/forks/joins. Snapshot source permits at most 16000 characters/256 lines, 24 snapshots per diagram; preprocessing, external resources, links, images and custom styling are unsupported. Rendering stays on the connected environment. Invalid or cancelled updates preserve the last valid image. No generated controls execute actions or send messages.
Sources are optional on component declarations only, with at most 8 named HTTP(S) links; use verified citations and never invent a URL or data. Fact values and table cells are strings, numbers or null. Row width must match columns. Chart values must be finite numbers, not formatted strings. Numbers have magnitude at most 1e12. Labels/titles are nonempty and at most 200 characters; other strings at most 2000. Each block is limited to 128000 characters, 512 records, 24 components, 12 table columns, 8 series per chart, 12 sections per report and 200 rows/points/items per collection. Close the fence, then continue normal Markdown. Do not emit HTML, JavaScript, JSX, CSS, arbitrary SVG, event handlers, tool calls or unlisted fields in a t3-ui block. This feature needs no HTML authoring, screenshot, preview or publication tool. Use ordinary Markdown when a visual exceeds these capabilities.

For richer visuals outside these components, build a self-contained HTML page, check it with \`html_preview\`, then publish it with \`html_render\` before your final reply. The reader sees that page above the reply, so add only what it does not say.
`;

export const T3_CODE_ORCHESTRATION_INSTRUCTIONS =
  T3_CODE_ORCHESTRATION_CONTROL_INSTRUCTIONS + T3_CODE_VISUAL_INSTRUCTIONS;

export const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `

## T3 Code browser

When browser work was asked, \`preview_*\` is the browser you share with the user: \`preview_status\` first, then \`preview_open\` if no tab can be automated. Prefer snapshot locators over coordinates. Switch browsers only if the tools are absent or \`preview_open\` says unsupported, the user asks, or two preview calls fail on one step. Then quote the error and switch.

For live web development, keep the user's existing development server and preview tab. Let the project's hot updates apply edits without refreshing or replacing the page unless the change requires it, so interactive state can survive. Treat selected preview elements as reference context for the user's spoken or written request; selection alone does not authorize a change. If the selected snapshot is insufficient, inspect the current page with the preview tools.
`;

const T3_CODE_DEVICE_TOOLS = ["device_list", "device_open", "device_screenshot", "device_close"];

const deviceToolInstructions = (loadTools: string) => `## T3 Code devices

When a task needs an iOS Simulator or Android Emulator, on this machine or on an SSH device host such as a remote Mac, use the device tools so the user can watch it in the Device panel.${loadTools}
1. Call \`device_list\` unless you already have the device's \`hostId\` and \`id\`.
2. Call \`device_open\` with both. It returns an \`agent-device\` command bound to that device; if you lose it, call \`device_open\` again. Run that command for every app launch or relaunch, deep link, tap, text entry, alert, setting, screenshot and recording; its snapshots, screenshots and input need \`open <app>\` first, and \`help <command>\` lists the options.
3. Call \`device_screenshot\` to look at the screen.

Never do those with \`xcrun simctl\`, \`idb\`, \`adb\`, ssh, or scripts that wrap them. ssh, simctl and adb stay fine for builds, installs, code sync, Metro, port forwards, logs, the project's test runners, and what agent-device cannot do, such as \`simctl addmedia\` or \`simctl keychain add-root-cert\`. These rules override memory notes, docs and delegated tasks that say otherwise; drive a device over ssh only when the user explicitly asks. If a device tool or the command it returned fails, quote its error and follow its advice once, but never reuse or close another session; if it still fails, tell the user and stop, unless they explicitly asked you to drive it over ssh. If the platform you need is unavailable, say so. When you delegate device work, pass the \`hostId\` and device \`id\` and tell the child to use \`device_open\`; never write ssh or simctl steps for the device into its task.`;

/** Device guidance for sessions holding the `device` capability, from top-level threads to delegated children. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS = deviceToolInstructions("");

/** Claude Code defers MCP tools behind ToolSearch, so Claude's copy says how to load them. */
export const T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH = deviceToolInstructions(
  ` Load them with ToolSearch \`select:${T3_CODE_DEVICE_TOOLS.map((tool) => `mcp__t3-code__${tool}`).join(",")}\`.`,
);

// ACP only: some ACP agents accept the injected MCP server but never expose
// its tools, so they need the terminal transport other harnesses never use.
const T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS = `ACP fallback: if the T3 tools are absent and \`T3_ACP_MCP_NODE\` is present, call them through the terminal: \`ELECTRON_RUN_AS_NODE=1 "$T3_ACP_MCP_NODE" \${T3_ACP_MCP_ENTRYPOINT:+"$T3_ACP_MCP_ENTRYPOINT"} acp-mcp-call orchestrator_capabilities '{}'\` (\`T3_ACP_MCP_ENTRYPOINT\` is unset for a standalone executable). Delegate with \`acp-mcp-call delegate_task '{"task":"...","target":{"providerInstanceId":"...","model":"..."},"mode":"async","clientRequestId":"..."}'\`.`;

const T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Default

Prefer making reasonable assumptions and carrying out the user's request. Ask a concise question only when a missing user decision would materially change the result. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

const T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS = `## T3 Code interaction mode: Plan

Investigate with read-only actions and do not edit files or otherwise execute the implementation. Resolve discoverable facts before asking questions. When the requirements are decision complete, return a concrete implementation plan and do not start implementing it. Treat this mode as active until T3 Code supplies a different interaction-mode instruction.`;

export interface T3AcpInstructionState {
  readonly interactionMode: ProviderInteractionMode;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
}

/** ACP lacks system/developer fields; inject context on first prompt and tool/mode changes. */
export function t3AcpPromptWithInstructions(input: {
  readonly prompt: string;
  readonly state: T3AcpInstructionState;
  readonly previousState?: T3AcpInstructionState;
}): string {
  // Native slash commands must remain at the start of the prompt.
  if (input.prompt.trimStart().startsWith("/")) return input.prompt;
  if (
    input.previousState?.interactionMode === input.state.interactionMode &&
    input.previousState.hasT3Mcp === input.state.hasT3Mcp &&
    input.previousState.hasDeviceTools === input.state.hasDeviceTools
  ) {
    return input.prompt;
  }
  const instructions = [
    input.state.interactionMode === "plan"
      ? T3_CODE_ACP_PLAN_MODE_INSTRUCTIONS
      : T3_CODE_ACP_DEFAULT_MODE_INSTRUCTIONS,
    ...(input.state.hasT3Mcp
      ? [
          T3_CODE_BROWSER_TOOL_INSTRUCTIONS.trim(),
          ...(input.state.hasDeviceTools ? [T3_CODE_DEVICE_TOOL_INSTRUCTIONS] : []),
          T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
          T3_CODE_ACP_MCP_FALLBACK_INSTRUCTIONS,
        ]
      : []),
  ];
  return `<t3_code_instructions>\n${instructions.join("\n\n")}\n</t3_code_instructions>\n\n<user_request>\n${input.prompt}\n</user_request>`;
}

const orchestrationInstructions = (hasDeviceTools: boolean) =>
  hasDeviceTools
    ? `${T3_CODE_ORCHESTRATION_INSTRUCTIONS}\n${T3_CODE_DEVICE_TOOL_INSTRUCTIONS}\n`
    : T3_CODE_ORCHESTRATION_INSTRUCTIONS;

function prependT3OrchestrationInstructions(prompt: string, instructions: string): string {
  return `<t3_code_orchestration_instructions>${instructions.trim()}</t3_code_orchestration_instructions>\n\n<user_request>\n${prompt}\n</user_request>`;
}

/** For providers whose instructions ride on the prompt, so a compacted conversation loses them. */
export function t3OrchestrationPrompt(input: {
  readonly prompt: string;
  readonly hasT3Mcp: boolean;
  readonly hasDeviceTools: boolean;
  readonly orchestrationDelivered: boolean;
  readonly deviceInstructionsDelivered: boolean;
}): string {
  if (!input.hasT3Mcp) return input.prompt;
  if (!input.orchestrationDelivered) {
    return prependT3OrchestrationInstructions(
      input.prompt,
      orchestrationInstructions(input.hasDeviceTools),
    );
  }
  return input.hasDeviceTools && !input.deviceInstructionsDelivered
    ? prependT3OrchestrationInstructions(input.prompt, T3_CODE_DEVICE_TOOL_INSTRUCTIONS)
    : input.prompt;
}

export function t3OrchestrationSystemPrompt(
  hasT3Mcp: boolean,
  hasDeviceTools: boolean,
): string | undefined {
  return hasT3Mcp ? orchestrationInstructions(hasDeviceTools) : undefined;
}

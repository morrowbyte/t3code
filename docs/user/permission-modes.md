# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread. A new thread names its mode under the composer. In a thread
on your default mode, open **Permissions** from the effort menu or press `mod+shift+a`. A thread on
another mode, or a model without an effort menu, shows the mode next to the model.

Set the default for new threads in **Settings → Threads → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; other actions can still require approval.          |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task.

## Review an action

To send an order through a protecting host, enable **Settings → Integrations → Protected tasks →
Show protected tasks**, then open the VM thread and choose **Protected task**
in the composer. Select the host, then send the original task through its configured VM channel.
The host records the task before forwarding it. This requires a configured host control thread
and paired VM channel activated by the host operator. Delivery does not require a host model
selection. Hiding the entry retains saved tasks and does not deactivate the host policy. Synthetic
test channels cannot execute actions.

Choose **Review action** on a pending request to inspect it full screen. Requests with a frozen
package include the process, complete source files, available changes and execution evidence.
Opening or closing a review never approves it. Examples and packages that fail verification cannot
be approved.

The **Order** view shows the exact captured original and selected excerpt separately from the
agent's rationale. Expand the original to read the complete stored host order. The context thread
is separate from that immutable original. Host actions require a verified order and request channel bound to the package. Older
requests and unsupported remote sources remain inspectable, but cannot be approved. A verified
original does not replace reviewing the proposed code or giving your one-time approval.

An action submitted to the host review service requires approval for that exact package from its
configured approver session, regardless of the agent's permission mode. A changed or expired package needs a new
request. An approval allows the action once; check its execution receipt and target readback before
treating the change as complete.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto** uses automatic review on Codex, Claude, Cursor, Grok, and fx; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval. On fx, prompts it still sends also come to you.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

T3 Code offers no **Auto-accept edits** or **Full access** for fx. An fx thread already set to either runs in
**Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Claude can still ask in **Full access** when its settings disable bypass permissions or require
approval for an action.
While a Claude approval is pending, type a text reply to decline that request and give feedback
directly to the agent that asked, including a subagent. Other pending requests stay unanswered.

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

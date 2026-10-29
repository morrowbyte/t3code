# Voice input in Morrowbyte Nightly

Record a message from the chat composer. **Stop** transcribes it into editable
prompt text. **Send** transcribes it and sends the prompt directly, including any
text already in your draft. A failed transcription or send keeps the recording
for playback and retry. Retrying a failed send uses the editable prompt without
inserting the same transcript twice. If the original text was removed or replaced
while sending, restore it with **Insert text** before retrying the recording.

Recordings stay with their original draft when you open Settings or switch
threads. Leaving during recording stops capture and keeps the audio for review;
it does not send a message. Return to that draft to listen, insert text, or send.
A successful insertion, accepted send, or **Discard recording** removes the saved
audio. Browser storage must remain available to keep audio across an app reload.

Transcription runs on the environment selected for that composer. A remote
environment uses its own configured transcription provider and login. Changing
the thread or environment cancels the current operation and ignores late
results, preserving reviewed audio on the original draft. Recordings are limited to 25 MiB.

Open **Settings → Voice → Voice transcription** to see the selected
environment's provider status, choose a Codex account, or explicitly configure
OpenAI API transcription. The default uses the enabled Codex instance, including
the built-in instance on a fresh profile. Existing sign-in is reused; no API key
is needed for account mode. A provider can still reject transcription even while
coding works; the failed recording remains available to retry.

OpenAI API mode uses API billing. Keys entered here go only to the environment's
private secret store and are never returned in settings. The key input remains
disabled until that environment confirms encrypted storage; update older servers
before entering a key. Leave the key blank to
retain it; **Remove saved key** removes the saved override. A key supplied by the
host's private launch environment remains managed by that host.

The separate phone control starts a voice call for an eligible signed-in Codex
thread. It needs microphone permission and WebRTC in a secure browser context.
Call availability also depends on the configured account. During a call you can
mute the microphone or speaker and end the call. Your speech and Live replies
appear in the thread alongside agent results. Ending releases the microphone;
saved conversations remain available across calls and app reloads. You can load
earlier calls and copy individual contributions. Incomplete transcripts are marked.
Voice contributions stay in the conversation without automatically becoming new
agent prompts. Leaving the thread ends its call; already submitted agent work
continues independently.

**Speech bubbles · Experimental** is off by default. Enable it in the call
controls or voice transcript for a live bubble view with the agent's avatar and a
separate microphone side for you. On mobile, the switch is labeled
**Sprechblasen · Experimentell**. Public conversation text updates as it arrives;
longer contributions are split for readability. This choice is saved on your
device; turn it off to return to the original transcript.

The live view shows real public tool activity, including recent GPT Live
completions and summaries of active thread tools. It does not expose hidden thinking.
Results, shared context, agent messages, approvals, and questions stay in chat.

Change the agent's theme under **Settings → Appearance → Agent identity**;
see [Agent identity](./appearance.md#agent-identity).

Keep talking while the agent works. Finished results return to the call for a
brief spoken explanation, and follow-up questions can use those results without
starting the same task again. You can interrupt speech or redirect an active
task. Interrupting speech leaves the background task running. A new call has
bounded recent chat context; ask for a result again if more detail is needed.

Describe a complete change and keep talking: the agent can start clear requests
before your whole contribution ends. Later corrections refine the existing work.
You do not need to say a special command to submit a spoken request.

For visual feedback, select an element in the browser preview and then talk about
it. The current selection is shared with the call without a typed comment. Clear
the selection or select another element when you change targets. The selection
contains a snapshot of the page at the time you picked it.

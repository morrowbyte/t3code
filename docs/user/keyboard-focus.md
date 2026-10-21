# Keyboard focus

Press Escape to leave the composer for keyboard navigation. Suggestions close first;
press Escape again to leave the editor. Press Space to explore commands and `i` to
return to writing. Navigation stays active while you move through the app. Use F6
and Shift+F6 to move between regions. Ctrl+Shift+Space opens app navigation from a
terminal or embedded browser; customize **Navigation: Activate** in Keybindings.

Space, then `c`, opens composer controls: `m` for model, `r` for reasoning,
`s` for service tier or speed, and `a` for access. Space, then `v`, provides
dictation, call and microphone commands. These actions keep their existing
connection permissions and availability.

Press `?` for help in the focused region or object, and Shift+F10 to search and
run its actions. Use `j`/`k` to move between objects and Enter for their primary
action. Lists also support arrows and Ctrl+N/P. Native editors, terminals and
embedded browsers keep their own text and navigation keys.

Use Space, then `a c`, to search controls in the focused region. Space, then
`a h`, labels visible controls; type a label to focus its control, then press
Enter to activate it. Space, then `r`, selects right-panel views. Space, then
`w s`, finds and runs a project action in the thread's workspace.

Focus a message and press `c` to copy it, `s` to select its text, or `q` to quote
the selected excerpt. Shift+Arrow adjusts the selected text. Code blocks offer
copy, wrapping and running in the terminal through their object actions. Queued
messages support `e` to edit, Delete to remove and Alt+Up/Down to reorder.

In a diff, `j`/`k` moves by line, Shift+J/K extends the selection, `[`/`]` moves
between hunks, and `{`/`}` moves between files. Press `c` to comment or `y` to
quote the selection in chat. Ctrl+Enter submits a comment; Escape cancels it.
File previews also provide **Select lines** for quoting and commenting.

Inside a terminal, Ctrl+Shift+F searches its output. Enter finds the next match;
Shift+Enter finds the previous one. Escape returns to the terminal. Use
Ctrl+PageUp/PageDown to switch terminal sessions. In an embedded browser,
Alt+Left/Right goes back and forward; the URL and refresh shortcuts remain
available in Keybindings.

Questions support arrows or `j`/`k` between options, Space for multiple choices
and Ctrl+Enter to continue or submit. An approval offers `a` to approve, `d` to
deny and `m` for its available scopes. Existing permission restrictions apply.

The command palette keeps focus while open. Closing a keyboard picker restores
the context it was opened from.
While the palette or model picker is open, number shortcuts select its entries instead of
switching threads. Model shortcuts work in Settings as well as the composer.
See [Keybindings](./keybindings.md) to customize these shortcuts.

If you return to typing while a terminal is starting, the composer keeps focus when the terminal
becomes ready. Opening or switching to a terminal explicitly still focuses it.

On mobile with a hardware keyboard, use Cmd+K on iOS or Ctrl+K on Android to
open the command palette. Its composer actions include model, provider options,
access, and local attachments. Escape closes suggestions before leaving the
composer; Space outside text fields opens the palette, and `i` returns to writing.

## Attach files with Yazi

Use Space, then `f a`, to open Yazi in file-selection mode. On desktop,
**This device** starts in the local environment's home directory; switch to
**Thread environment** to select remote files. The selected source and home
path remain visible. Yazi must be installed on that source and available on
its PATH. The desktop's local environment must be enabled in Connections.

Use Yazi's normal navigation, Space to select multiple files, Enter to attach
the selection and `q` to cancel. Escape belongs to Yazi's search and selection
modes. Shift+Tab returns to the source controls. Files are added to the current
draft and use the normal upload limits. Closing or switching the picker cancels
its selection session. The system picker remains available for local files,
including web browsers that cannot open a terminal on the client device.

In a web browser, **Choose folder** grants access to a local folder and opens
a keyboard explorer for it. Use arrows or `j`/`k` to move, Left/`h` to go up,
Right/`l` or Enter to enter a folder, Space to mark files across folders,
`p` to preview and `/` to filter. Ctrl+Enter attaches the marked files. Remove
an entry from the selection before attaching, or press Space on it again.
The browser can only browse the folder you granted; selecting **Thread
environment** opens Yazi on the environment instead.

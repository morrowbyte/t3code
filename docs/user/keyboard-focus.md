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

Use Space, then `a c`, to search controls in the focused region. Space, then
`a h`, labels visible controls; type a label to focus its control, then press
Enter to activate it. Space, then `r`, selects right-panel views. Space, then
`w s`, finds and runs a project action in the thread's workspace.

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

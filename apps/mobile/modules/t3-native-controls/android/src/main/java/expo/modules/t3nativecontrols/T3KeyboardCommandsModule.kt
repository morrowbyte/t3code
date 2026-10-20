package expo.modules.t3nativecontrols

import android.content.Context
import android.view.KeyEvent
import android.text.Spannable
import android.view.inputmethod.BaseInputConnection
import android.widget.TextView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

class T3KeyboardCommandsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3KeyboardCommands")

    View(T3KeyboardCommandsView::class) {
      Prop("enabledCommands") { view: T3KeyboardCommandsView, commands: List<String> ->
        view.enabledCommands = commands.toSet()
      }
      Events("onCommand")
    }
  }
}

class T3KeyboardCommandsView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val onCommand by EventDispatcher()
  var enabledCommands = emptySet<String>()

  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val command = commandFor(event)?.takeIf { enabledCommands.contains(it) }
    if (command != null) onCommand(mapOf("command" to command))
    return command != null || super.dispatchKeyEvent(event)
  }

  private fun commandFor(event: KeyEvent): String? {
    if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount != 0 || event.isAltPressed || event.isMetaPressed) {
      return null
    }
    val focusedText = findFocus() as? TextView
    val text = focusedText?.text as? Spannable
    if (text != null && BaseInputConnection.getComposingSpanStart(text) >= 0) return null
    if (!event.isCtrlPressed && !event.isShiftPressed) {
      return when (event.keyCode) {
        KeyEvent.KEYCODE_ESCAPE -> if (enabledCommands.contains("paletteDismiss")) "paletteDismiss" else "composerEscape"
        KeyEvent.KEYCODE_DPAD_DOWN -> "paletteNext"
        KeyEvent.KEYCODE_DPAD_UP -> "palettePrevious"
        KeyEvent.KEYCODE_SPACE -> if (focusedText?.onCheckIsTextEditor() != true) "keyboardNavigation" else null
        KeyEvent.KEYCODE_I -> if (focusedText?.onCheckIsTextEditor() != true) "composerFocus" else null
        else -> null
      }
    }
    if (!event.isCtrlPressed) return null
    if (event.isShiftPressed) {
      return when (event.keyCode) {
        KeyEvent.KEYCODE_C -> "copyThreadReference"
        KeyEvent.KEYCODE_H -> "cycleHost"
        KeyEvent.KEYCODE_F -> "files"
        KeyEvent.KEYCODE_T -> "terminal"
        KeyEvent.KEYCODE_R -> "review"
        else -> null
      }
    }
    return when (event.keyCode) {
      KeyEvent.KEYCODE_K -> "commandPalette"
      KeyEvent.KEYCODE_N -> if (enabledCommands.contains("paletteNext")) "paletteNext" else "newTask"
      KeyEvent.KEYCODE_F -> "focusSearch"
      KeyEvent.KEYCODE_J -> "paletteNext"
      KeyEvent.KEYCODE_P -> "palettePrevious"
      KeyEvent.KEYCODE_LEFT_BRACKET -> "back"
      KeyEvent.KEYCODE_BACKSLASH -> "toggleSidebar"
      in KeyEvent.KEYCODE_1..KeyEvent.KEYCODE_9 -> "thread.jump.${event.keyCode - KeyEvent.KEYCODE_1 + 1}"
      else -> null
    }
  }
}

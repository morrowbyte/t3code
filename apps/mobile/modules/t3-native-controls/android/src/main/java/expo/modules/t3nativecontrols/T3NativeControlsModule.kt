package expo.modules.t3nativecontrols

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ResultReceiver
import expo.modules.kotlin.functions.Queues
import android.text.format.DateFormat
import androidx.core.content.FileProvider
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI

class T3NativeControlsModule : Module() {
  private var filePreviewPromise: Promise? = null
  private var voiceSessionId: String? = null
  private val voiceStopped: (String, String) -> Unit = { sessionId, reason ->
    sendEvent("onVoiceSessionStopped", mapOf("sessionId" to sessionId, "reason" to reason))
  }

  @Suppress("TooGenericExceptionCaught") // Clear the pending promise before rethrowing.
  override fun definition() = ModuleDefinition {
    Name("T3NativeControls")
    Events("onVoiceSessionStopped")

    OnCreate { T3VoiceSessionService.onStopped = voiceStopped }
    OnDestroy {
      voiceSessionId?.let { T3VoiceSessionService.stop(it) }
      if (T3VoiceSessionService.onStopped === voiceStopped) T3VoiceSessionService.onStopped = null
    }
    Function("isVoiceSessionActive") { sessionId: String -> T3VoiceSessionService.isActive(sessionId) }
    AsyncFunction("startVoiceSession") { sessionId: String, promise: Promise ->
      val context = appContext.reactContext ?: error("The app is not active.")
      check(appContext.currentActivity != null) { "Start voice from the visible app." }
      voiceSessionId = sessionId
      val reply = object : ResultReceiver(Handler(Looper.getMainLooper())) {
        override fun onReceiveResult(code: Int, data: Bundle?) {
          if (code == 0) promise.resolve(null)
          else promise.reject("VOICE_FOREGROUND_START_FAILED", data?.getString("error") ?: "Could not start background voice.", null)
        }
      }
      ContextCompat.startForegroundService(context, Intent(context, T3VoiceSessionService::class.java).apply {
        action = T3VoiceSessionService.START
        putExtra(T3VoiceSessionService.SESSION, sessionId)
        putExtra(T3VoiceSessionService.REPLY, reply)
      })
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stopVoiceSession") { sessionId: String ->
      T3VoiceSessionService.stop(sessionId)
      if (voiceSessionId == sessionId) voiceSessionId = null
    }.runOnQueue(Queues.MAIN)

    Function("is24HourFormat") {
      val context = appContext.reactContext ?: error("The app is not active.")
      DateFormat.is24HourFormat(context)
    }

    AsyncFunction("openFile") { uri: String, mimeType: String, promise: Promise ->
      check(filePreviewPromise == null) { "A document viewer is already open." }
      val activity = appContext.currentActivity ?: error("The app is not active.")
      val file = File(URI(uri)).canonicalFile
      require(file.isFile) { "The file is no longer available." }
      val contentUri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.FileSystemFileProvider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, mimeType)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      filePreviewPromise = promise
      try {
        activity.startActivityForResult(intent, 7343)
      } catch (error: Exception) {
        filePreviewPromise = null
        throw error
      }
    }

    OnActivityResult { _, (requestCode) ->
      if (requestCode == 7343) {
        filePreviewPromise?.resolve(null)
        filePreviewPromise = null
      }
    }

    Function("getShowcasePairingUrl") {
      appContext.currentActivity?.intent?.getStringExtra("showcasePairingUrl")
    }

    Function("getShowcaseScene") {
      val storedScene = appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-scene")
        ?.takeIf { it.isFile }
        ?.readText()
        ?.trim()
        ?.takeIf { it.isNotEmpty() }
      storedScene ?: appContext.currentActivity?.intent?.getStringExtra("showcaseScene")
    }

    // The palette is fixed for the whole capture, so it only ever arrives as a
    // launch extra — unlike the scene, which the runner rewrites in place.
    Function("getShowcaseTheme") {
      appContext.currentActivity?.intent?.getStringExtra("showcaseTheme")
    }

    Function("prepareShowcaseCapture") {
      // Android app data is cleared by the host runner before launch.
    }

    Function("markShowcaseReady") { scene: String ->
      appContext.reactContext
        ?.filesDir
        ?.resolve("t3-showcase-ready")
        ?.writeText(scene)
    }
  }
}

package expo.modules.t3nativecontrols

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.ResultReceiver
import android.app.KeyguardManager
import android.util.Log
import androidx.core.app.ServiceCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/** Only an explicitly started call owns this service; process death never restarts capture. */
class T3VoiceSessionService : HeadlessJsTaskService() {
  private var owner: String? = null
  private var audioManager: AudioManager? = null
  private var focusRequest: AudioFocusRequest? = null
  private var screenObserverRegistered = false
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
      finishSession("audio-focus-lost")
    }
  }
  private val screenObserver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      val power = getSystemService(PowerManager::class.java)
      val keyguard = getSystemService(KeyguardManager::class.java)
      Log.i(TAG, "${intent.action}: interactive=${power.isInteractive}, locked=${keyguard.isKeyguardLocked}, active=${owner != null}")
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val requested = intent?.getStringExtra(SESSION)
    if (intent?.action == STOP) {
      if (owner != null && requested == owner) finishSession("notification")
      else if (owner == null) stopSelf()
      return Service.START_NOT_STICKY
    }
    if (intent?.action != START || requested.isNullOrEmpty()) {
      if (owner == null) stopSelf()
      return Service.START_NOT_STICKY
    }
    @Suppress("DEPRECATION")
    val reply = intent.getParcelableExtra<ResultReceiver>(REPLY)
    if (owner != null) {
      reply?.send(if (owner == requested) 0 else 1, Bundle().apply {
        putString("error", "Another voice call is already active.")
      })
      return Service.START_NOT_STICKY
    }
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
          NotificationChannel(CHANNEL, "Voice chat", NotificationManager.IMPORTANCE_LOW)
        )
      }
      val end = Intent(this, T3VoiceSessionService::class.java).apply {
        action = STOP
        putExtra(SESSION, requested)
        data = Uri.parse("t3-voice-session:$requested")
      }
      val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL) else {
        @Suppress("DEPRECATION")
        Notification.Builder(this)
      }
      val notification = builder.setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentTitle("Morrowbyte · Voice chat")
        .setContentText("Microphone and audio active")
        .setCategory(Notification.CATEGORY_CALL)
        .setVisibility(Notification.VISIBILITY_PRIVATE)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .addAction(Notification.Action.Builder(null, "End call", PendingIntent.getService(
          this, 0, end, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )).build())
      packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
        notification.setContentIntent(PendingIntent.getActivity(
          this, 0, launch, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        ))
      }
      ServiceCompat.startForeground(this, NOTIFICATION, notification.build(),
        ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      owner = requested
      audioManager = getSystemService(AudioManager::class.java)
      val manager = checkNotNull(audioManager)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
          .setAudioAttributes(AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
          .setOnAudioFocusChangeListener(focusListener, Handler(Looper.getMainLooper()))
          .build()
        focusRequest = focus
        check(manager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
          "Audio focus is unavailable."
        }
      } else {
        @Suppress("DEPRECATION")
        val granted = manager.requestAudioFocus(focusListener, AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        check(granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus is unavailable." }
      }
      val filter = IntentFilter().apply {
        addAction(Intent.ACTION_SCREEN_OFF)
        addAction(Intent.ACTION_SCREEN_ON)
        addAction(Intent.ACTION_USER_PRESENT)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(screenObserver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        registerReceiver(screenObserver, filter)
      }
      screenObserverRegistered = true
      // React Native otherwise pauses JS timers on host pause, including transport recovery.
      startTask(HeadlessJsTaskConfig("T3LiveVoice", Arguments.createMap().apply {
        putString(SESSION, requested)
      }, 0, true))
      Log.i(TAG, "Started user voice foreground session")
      reply?.send(0, Bundle())
    } catch (failure: Exception) {
      reply?.send(1, Bundle().apply { putString("error", failure.message) })
      finishSession("start-failed", notify = false)
    }
    return Service.START_NOT_STICKY
  }

  private fun finishSession(reason: String, notify: Boolean = true) {
    val ended = owner
    owner = null
    if (screenObserverRegistered) {
      unregisterReceiver(screenObserver)
      screenObserverRegistered = false
    }
    val manager = audioManager
    val focus = focusRequest
    audioManager = null
    focusRequest = null
    runCatching {
      if (manager != null) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          focus?.let { manager.abandonAudioFocusRequest(it) }
        } else {
          @Suppress("DEPRECATION")
          manager.abandonAudioFocus(focusListener)
        }
      }
    }.onFailure { Log.w(TAG, "Could not restore audio focus after voice ended") }
    if (ended != null) {
      Log.i(TAG, "Stopped user voice foreground session: $reason")
      if (notify) runCatching { onStopped?.invoke(ended, reason) }
        .onFailure { Log.w(TAG, "Voice stopped after React context was unavailable") }
    }
    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    finishSession("task-removed")
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    finishSession("destroyed")
    if (instance === this) instance = null
    super.onDestroy()
  }

  companion object {
    const val SESSION = "sessionId"
    const val REPLY = "reply"
    const val START = "t3.voice.START"
    const val STOP = "t3.voice.STOP"
    private const val CHANNEL = "t3-live-voice"
    private const val NOTIFICATION = 7344
    private const val TAG = "T3LiveVoice"
    private var instance: T3VoiceSessionService? = null
    var onStopped: ((String, String) -> Unit)? = null
    fun isActive(sessionId: String): Boolean = instance?.owner == sessionId
    fun stop(sessionId: String) {
      instance?.let { if (it.owner == sessionId) it.finishSession("ended") }
    }
  }
}

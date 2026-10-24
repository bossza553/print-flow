package io.github.bossza553.printflow

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * Foreground service that behaves like an alarm clock: full-screen red screen, looping alarm sound on the
 * ALARM audio stream (ignores media volume), strong vibration, until the user taps รับทราบ or 5 minutes pass.
 */
class AlarmService : Service() {
    private var player: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val handler = Handler(Looper.getMainLooper())
    private val autoStop = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) { stopSelf(); return START_NOT_STICKY }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: getString(R.string.new_job)
        val body = intent?.getStringExtra(EXTRA_BODY) ?: ""
        val url = intent?.getStringExtra(EXTRA_URL) ?: ""
        val alarm = intent?.getBooleanExtra(EXTRA_ALARM, true) ?: true

        val notification = buildNotification(title, body, url, alarm)
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else startForeground(NOTIF_ID, notification)

        if (alarm) {
            acquireWakeLock()
            startSound()
            startVibration()
            handler.removeCallbacks(autoStop)
            handler.postDelayed(autoStop, MAX_MS)
            // bring the red screen up (works on lock screen thanks to showWhenLocked/turnScreenOn)
            try {
                startActivity(AlarmActivity.intent(this, title, body, url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: Exception) { }
        } else {
            handler.postDelayed(autoStop, 3000)
        }
        return START_NOT_STICKY
    }

    private fun buildNotification(title: String, body: String, url: String, alarm: Boolean): Notification {
        val open = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java).putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val fullScreen = PendingIntent.getActivity(
            this, 2, AlarmActivity.intent(this, title, body, url),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val stop = PendingIntent.getService(
            this, 3, Intent(this, AlarmService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, App.CHANNEL_ALARM)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(alarm)
            .setAutoCancel(!alarm)
            .setContentIntent(open)
            .setFullScreenIntent(fullScreen, true)
            .addAction(0, getString(R.string.ack), stop)
            .addAction(0, getString(R.string.open_app), open)
            // the service plays its own sound; keep the channel sound off to avoid doubling
            .setSilent(alarm)
            .build()
    }

    private fun startSound() {
        try {
            val am = getSystemService(AudioManager::class.java)
            // make sure the alarm stream is audible even if the user turned it down
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            if (am.getStreamVolume(AudioManager.STREAM_ALARM) < max * 0.7) am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(this@AlarmService, uri)
                isLooping = true
                setVolume(1f, 1f)
                prepare()
                start()
            }
        } catch (_: Exception) { }
    }

    private fun startVibration() {
        vibrator = if (Build.VERSION.SDK_INT >= 31) getSystemService(VibratorManager::class.java).defaultVibrator
        else @Suppress("DEPRECATION") getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        val pattern = longArrayOf(0, 900, 400, 900, 400, 900, 1200)
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build()
        try {
            if (Build.VERSION.SDK_INT >= 26) vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0), attrs)
            else @Suppress("DEPRECATION") vibrator?.vibrate(pattern, 0)
        } catch (_: Exception) { }
    }

    private fun acquireWakeLock() {
        try {
            val pm = getSystemService(PowerManager::class.java)
            @Suppress("DEPRECATION")
            wakeLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "printflow:alarm").apply { acquire(MAX_MS) }
        } catch (_: Exception) { }
    }

    override fun onDestroy() {
        handler.removeCallbacks(autoStop)
        try { player?.stop(); player?.release() } catch (_: Exception) { }
        player = null
        try { vibrator?.cancel() } catch (_: Exception) { }
        try { if (wakeLock?.isHeld == true) wakeLock?.release() } catch (_: Exception) { }
        NotificationManagerCompat.from(this).cancel(NOTIF_ID)
        AlarmActivity.finishIfShowing()
        super.onDestroy()
    }

    companion object {
        const val NOTIF_ID = 4242
        const val ACTION_STOP = "io.github.bossza553.printflow.STOP"
        const val EXTRA_TITLE = "title"; const val EXTRA_BODY = "body"; const val EXTRA_URL = "url"; const val EXTRA_ALARM = "alarm"
        const val MAX_MS = 5 * 60 * 1000L

        fun start(ctx: Context, title: String, body: String, url: String, alarm: Boolean) {
            val i = Intent(ctx, AlarmService::class.java)
                .putExtra(EXTRA_TITLE, title).putExtra(EXTRA_BODY, body).putExtra(EXTRA_URL, url).putExtra(EXTRA_ALARM, alarm)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, AlarmService::class.java)) }
    }
}

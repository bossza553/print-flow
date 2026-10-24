package io.github.bossza553.printflow

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions

class App : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.FB_APP_ID.isNotBlank() && FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setProjectId(BuildConfig.FB_PROJECT_ID)
                    .setApplicationId(BuildConfig.FB_APP_ID)
                    .setApiKey(BuildConfig.FB_API_KEY)
                    .setGcmSenderId(BuildConfig.FB_SENDER_ID)
                    .build()
            )
        }
        createChannels()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(NotificationManager::class.java)
        val alarmAttrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
        val ch = NotificationChannel(CHANNEL_ALARM, getString(R.string.channel_alarm), NotificationManager.IMPORTANCE_HIGH).apply {
            description = getString(R.string.channel_alarm_desc)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarmAttrs)
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 300, 800, 300, 800)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        }
        nm.createNotificationChannel(ch)
    }

    companion object {
        const val CHANNEL_ALARM = "alarm"
        const val PREFS = "pf"
        const val KEY_SESSION = "session_token"
        const val KEY_FCM = "fcm_token"
    }
}

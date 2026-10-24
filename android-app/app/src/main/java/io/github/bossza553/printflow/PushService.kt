package io.github.bossza553.printflow

import android.content.Context
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** Receives data messages from the Print Flow API and turns them into a looping alarm. */
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        getSharedPreferences(App.PREFS, Context.MODE_PRIVATE).edit().putString(App.KEY_FCM, token).apply()
        Api.registerFcmIfPossible(this)
    }

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val title = d["title"] ?: msg.notification?.title ?: getString(R.string.new_job)
        val body = d["body"] ?: msg.notification?.body ?: ""
        val url = d["url"] ?: ""
        val alarm = d["alarm"] == "true" || d["alarm"] == "1"
        AlarmService.start(this, title, body, url, alarm)
    }
}

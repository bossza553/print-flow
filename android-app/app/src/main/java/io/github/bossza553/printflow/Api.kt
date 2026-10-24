package io.github.bossza553.printflow

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/** Tiny client for the Print Flow API: registers this phone's FCM token under the logged-in user. */
object Api {
    private const val TAG = "PrintFlowApi"

    fun registerFcmIfPossible(ctx: Context) {
        val prefs = ctx.getSharedPreferences(App.PREFS, Context.MODE_PRIVATE)
        val session = prefs.getString(App.KEY_SESSION, null) ?: return
        val fcm = prefs.getString(App.KEY_FCM, null) ?: return
        post(ctx, "/api/fcm/register", session, JSONObject().put("token", fcm).put("platform", "android"))
    }

    fun unregisterFcm(ctx: Context) {
        val prefs = ctx.getSharedPreferences(App.PREFS, Context.MODE_PRIVATE)
        val fcm = prefs.getString(App.KEY_FCM, null) ?: return
        post(ctx, "/api/fcm/unregister", null, JSONObject().put("token", fcm))
    }

    private fun post(ctx: Context, path: String, bearer: String?, body: JSONObject) {
        thread {
            try {
                val conn = URL(BuildConfig.API_BASE + path).openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.connectTimeout = 10000; conn.readTimeout = 10000
                conn.setRequestProperty("Content-Type", "application/json")
                if (bearer != null) conn.setRequestProperty("Authorization", "Bearer $bearer")
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
                val code = conn.responseCode
                Log.i(TAG, "$path -> $code")
                conn.disconnect()
            } catch (e: Exception) {
                Log.w(TAG, "$path failed: ${e.message}")
            }
        }
    }
}

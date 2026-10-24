package io.github.bossza553.printflow

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView

    private val askNotif = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        web = findViewById(R.id.web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = android.webkit.WebSettings.LOAD_DEFAULT
            userAgentString = "$userAgentString PrintFlowApp/2.0"
        }
        web.addJavascriptInterface(Bridge(this), "Android")
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                // keep the app inside; open anything else (e.g. GitHub, Line) in the system browser
                if (url.startsWith(BuildConfig.WEB_URL) || url.startsWith("about:")) return false
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                return true
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (web.canGoBack()) web.goBack() else { isEnabled = false; onBackPressedDispatcher.onBackPressed() } }
        })

        if (savedInstanceState == null) web.loadUrl(BuildConfig.WEB_URL + (intent.getStringExtra("url") ?: ""))
        else web.restoreState(savedInstanceState)

        requestNotificationPermission()
        askIgnoreBatteryOnce()
        fetchFcmToken()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.getStringExtra("url")?.let { web.loadUrl(BuildConfig.WEB_URL + it) }
    }

    override fun onSaveInstanceState(outState: Bundle) { super.onSaveInstanceState(outState); web.saveState(outState) }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    /** Ask once to be excluded from battery optimisation so alarms arrive during Doze. */
    @SuppressLint("BatteryLife")
    private fun askIgnoreBatteryOnce() {
        val prefs = getSharedPreferences(App.PREFS, Context.MODE_PRIVATE)
        if (prefs.getBoolean("asked_battery", false)) return
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) return
        prefs.edit().putBoolean("asked_battery", true).apply()
        try {
            startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
        } catch (_: Exception) { }
    }

    private fun fetchFcmToken() {
        if (FirebaseApp.getApps(this).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            getSharedPreferences(App.PREFS, Context.MODE_PRIVATE).edit().putString(App.KEY_FCM, token).apply()
            Api.registerFcmIfPossible(this)
        }
    }

    /** Called from the web app (window.Android.*) */
    class Bridge(private val activity: MainActivity) {
        @JavascriptInterface fun isNative(): Boolean = true

        @JavascriptInterface fun onLogin(sessionToken: String) {
            activity.getSharedPreferences(App.PREFS, Context.MODE_PRIVATE).edit().putString(App.KEY_SESSION, sessionToken).apply()
            Api.registerFcmIfPossible(activity)
        }

        @JavascriptInterface fun onLogout() {
            Api.unregisterFcm(activity)
            activity.getSharedPreferences(App.PREFS, Context.MODE_PRIVATE).edit().remove(App.KEY_SESSION).apply()
        }

        @JavascriptInterface fun stopAlarm() { AlarmService.stop(activity) }
    }
}

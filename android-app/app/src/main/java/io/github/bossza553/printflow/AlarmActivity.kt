package io.github.bossza553.printflow

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import java.lang.ref.WeakReference

/** Full-screen red alarm screen shown over the lock screen until the user taps รับทราบ. */
class AlarmActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()
        setContentView(R.layout.activity_alarm)
        current = WeakReference(this)
        findViewById<TextView>(R.id.title).text = intent.getStringExtra(AlarmService.EXTRA_TITLE) ?: getString(R.string.new_job)
        findViewById<TextView>(R.id.body).text = intent.getStringExtra(AlarmService.EXTRA_BODY) ?: ""
        val url = intent.getStringExtra(AlarmService.EXTRA_URL) ?: ""
        findViewById<Button>(R.id.ack).setOnClickListener {
            AlarmService.stop(this)
            startActivity(Intent(this, MainActivity::class.java).putExtra("url", url).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
            finish()
        }
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true); setTurnScreenOn(true)
            getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onDestroy() { if (current?.get() === this) current = null; super.onDestroy() }

    companion object {
        private var current: WeakReference<AlarmActivity>? = null
        fun intent(ctx: Context, title: String, body: String, url: String) = Intent(ctx, AlarmActivity::class.java)
            .putExtra(AlarmService.EXTRA_TITLE, title).putExtra(AlarmService.EXTRA_BODY, body).putExtra(AlarmService.EXTRA_URL, url)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        fun finishIfShowing() { (current?.get() as? Activity)?.finish() }
    }
}

@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import android.content.*
import android.os.Bundle
import android.os.IBinder
import android.widget.FrameLayout
import android.widget.Button
import android.view.Gravity
import android.view.View
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.activity.result.contract.ActivityResultContracts
import android.net.Uri
import android.webkit.ValueCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

open class MainActivity : AppCompatActivity() {
    private lateinit var container: FrameLayout
    private var host: BrowserHost? = null
    private var bound = false
    private lateinit var settingsButton: Button
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private val filePicker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        fileCallback = null
    }
    fun chooseFile(callback: ValueCallback<Array<Uri>>, types: Array<String>): Boolean {
        fileCallback?.onReceiveValue(null)
        fileCallback = callback
        return runCatching { filePicker.launch(types.ifEmpty { arrayOf("text/*", "application/octet-stream") }); true }
            .getOrElse { fileCallback = null; callback.onReceiveValue(null); false }
    }
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            val browser = (binder as PlaybackService.LocalBinder).service.browser
            host = browser
            browser.attach(this@MainActivity, container)
            if (::settingsButton.isInitialized) container.removeView(settingsButton)
            settingsButton = Button(this@MainActivity).apply {
                text = "⚙"
                contentDescription = "SoundCloud settings"
                setTextColor(0xffff773d.toInt())
                setOnClickListener { browser.openSettings() }
            }
            val size = (48 * resources.displayMetrics.density).toInt()
            container.addView(settingsButton, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.END))
            browser.onLoading = { loading -> settingsButton.visibility = if (loading) View.VISIBLE else View.GONE }
            browser.start(BuildConfig.DEBUG && intent.getBooleanExtra("fixture", false))
            browser.view.evaluateJavascript("Boolean(document.getElementById('android-open-settings'))") { result ->
                settingsButton.visibility = if (result == "true") View.GONE else View.VISIBLE
            }
        }
        override fun onServiceDisconnected(name: ComponentName) { host = null }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        container = FrameLayout(this)
        container.setBackgroundColor(0xff121212.toInt())
        setContentView(container)
        ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        bound = bindService(Intent(this, PlaybackService::class.java).setAction("io.rvelabs.soundcloud.BIND_UI"),
            connection, Context.BIND_AUTO_CREATE)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val browser = host
                if (browser != null && browser.back()) return
                finish()
            }
        })
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        fileCallback = null
        host?.detach(container)
        if (bound) unbindService(connection)
        super.onDestroy()
    }
}

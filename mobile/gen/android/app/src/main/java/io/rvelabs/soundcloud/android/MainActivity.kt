@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import android.content.*
import android.os.Bundle
import android.os.IBinder
import android.widget.FrameLayout
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
            browser.start(BuildConfig.DEBUG && intent.getBooleanExtra("fixture", false))
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

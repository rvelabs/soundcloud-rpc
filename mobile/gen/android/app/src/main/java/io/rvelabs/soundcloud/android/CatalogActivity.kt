package io.rvelabs.soundcloud.android

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

class CatalogActivity : AppCompatActivity() {
    private lateinit var browser: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        browser = WebView(this)
        browser.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        browser.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val uri = request.url
                val host = uri.host?.lowercase()
                if (uri.scheme != "https") return true
                if (host == "soundcloud.com" || host?.endsWith(".soundcloud.com") == true) return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                return true
            }
        }
        setContentView(browser)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (browser.canGoBack()) browser.goBack() else finish()
            }
        })
        if (savedInstanceState == null || browser.restoreState(savedInstanceState) == null) {
            browser.loadUrl(Uri.parse("https://soundcloud.com/").toString())
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        browser.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        (browser.parent as? android.view.ViewGroup)?.removeView(browser)
        browser.destroy()
        super.onDestroy()
    }
}

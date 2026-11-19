@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import android.app.Dialog
import android.content.MutableContextWrapper
import android.webkit.*
import android.view.ViewGroup
import androidx.webkit.*
import org.json.JSONObject
import java.util.concurrent.Executor

/** Privileged settings run in a local origin, isolated from SoundCloud scripts and ads. */
class SettingsPanel(private val context: MutableContextWrapper, private val host: BrowserHost, private val worker: Executor) {
    private var dialog: Dialog? = null
    fun show() {
        if (dialog != null) return
        val activity = context.baseContext as? MainActivity ?: return
        val view = WebView(activity)
        view.settings.javaScriptEnabled = true
        view.settings.allowFileAccess = false
        view.settings.allowContentAccess = false
        val loader = WebViewAssetLoader.Builder().addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(context)).build()
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                androidx.appcompat.app.AlertDialog.Builder(activity).setMessage(message)
                    .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                    .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
        }
        val allowed = setOf("client_options", "profile_load", "profile_save", "profile_flush", "catalog_request", "analysis_reset", "adblock_action",
            "listening_status", "listening_options", "lastfm_action", "connection_load", "connection_save", "worker_setup_action", "native_diagnostics")
        WebViewCompat.addWebMessageListener(view, "__SC_ANDROID", setOf("https://appassets.androidplatform.net")) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.host != "appassets.androidplatform.net") return@addWebMessageListener
            runCatching {
                val raw = message.data ?: return@runCatching
                require(raw.length <= 1_000_000)
                val request = JSONObject(raw)
                val id = request.getString("id")
                val command = request.getString("command")
                val args = request.optJSONObject("args") ?: JSONObject()
                fun answer(value: Any?, error: String? = null) {
                    view.post { runCatching { reply.postMessage(JSONObject().put("id", id).put("value", value ?: JSONObject.NULL)
                        .apply { if (error != null) put("error", error) }.toString()) } }
                }
                when (command) {
                    "android_close_settings" -> { dialog?.dismiss(); answer(null) }
                    "android_open" -> { host.openExternal(args.getString("url")); answer(null) }
                    "android_language" -> { host.evaluate("void window.waveInline?.setLanguage(${JSONObject.quote(args.getString("language"))})"); answer(null) }
                    "android_reload" -> { host.reload(); dialog?.dismiss(); answer(null) }
                    "android_control" -> { host.setSpeed(args.optDouble("rate", 1.0)); answer(null) }
                    else -> {
                        check(command in allowed)
                        if (command.startsWith("profile_")) check(args.optString("key") == "settings")
                        if (command == "catalog_request") check(args.getJSONObject("request").optString("operation") == "me")
                        worker.execute {
                            runCatching { RustBridge.call(command, args) }.onSuccess {
                                answer(it)
                                if (command == "client_options" && it is JSONObject) view.post { host.applyTextZoom(it.optDouble("zoom", 1.0)) }
                                if (command == "client_options" || command == "listening_options") view.post { host.evaluate("void window.__soundcloudNative?.settingsChanged()") }
                            }.onFailure { answer(null, it.message ?: "Settings operation failed") }
                        }
                    }
                }
            }
        }
        dialog = Dialog(activity).also { panel ->
            panel.setContentView(view)
            panel.setOnDismissListener { view.stopLoading(); view.destroy(); dialog = null }
            panel.show()
            panel.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        view.loadUrl("https://appassets.androidplatform.net/assets/android-settings.html")
    }
    fun close() { dialog?.dismiss() }
}

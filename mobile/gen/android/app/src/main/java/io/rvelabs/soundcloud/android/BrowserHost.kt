package io.rvelabs.soundcloud.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.*
import android.net.Uri
import android.os.*
import android.util.Base64
import android.view.ViewGroup
import android.webkit.*
import android.widget.FrameLayout
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import androidx.webkit.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.concurrent.*

@SuppressLint("SetJavaScriptEnabled")
@UnstableApi
class BrowserHost(private val service: PlaybackService) {
    var onLoading: ((Boolean) -> Unit)? = null
    private val context = MutableContextWrapper(service)
    val view = WebView(context)
    private val main = Handler(Looper.getMainLooper())
    private val spotify = SpotifySession(context)
    private val workers = ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, ArrayBlockingQueue(64))
    private val playbackWorkers = ThreadPoolExecutor(1, 2, 30, TimeUnit.SECONDS, ArrayBlockingQueue(8))
    private val settings = SettingsPanel(context, this, workers)
    private var started = false
    private var fixture = false
    @Volatile private var source = "https://soundcloud.com/"
    private val bootstrap by lazy { asset("android-bootstrap.js") }
    private val injected by lazy { asset("android-inject.js") }
    private fun asset(name: String) = service.assets.open(name).bufferedReader().use { it.readText() }

    init {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
            setSupportZoom(false)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(webView: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (Uri.parse(webView.url.orEmpty()).host != "soundcloud.com") return false
                val activity = context.baseContext as? MainActivity ?: return false
                return activity.chooseFile(callback, arrayOf("text/*", "application/csv", "application/octet-stream"))
            }
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        require(WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            "Обнови Android System WebView для запуска SoundCloud."
        }
        WebViewCompat.addWebMessageListener(view, "__SC_ANDROID", setOf("https://soundcloud.com")) { _, message, origin, mainFrame, reply ->
            if (!mainFrame || origin.scheme != "https" || origin.host != "soundcloud.com") return@addWebMessageListener
            val text = message.data ?: return@addWebMessageListener
            if (text.length > 8_000_000) return@addWebMessageListener
            val request = runCatching { JSONObject(text) }.getOrNull() ?: return@addWebMessageListener
            val id = request.optString("id")
            if (id.length > 80) return@addWebMessageListener
            val command = request.optString("command")
            val args = request.optJSONObject("args") ?: JSONObject()
            fun answer(value: Any?, error: String? = null) {
                val result = JSONObject().put("id", id)
                if (error != null) result.put("error", error) else result.put("value", value ?: JSONObject.NULL)
                runCatching { reply.postMessage(result.toString()) }
            }
            try { when (command) {
                "android_control" -> {
                    when (args.optString("command")) {
                        "seek" -> service.player.seekTo(args.optLong("position").coerceIn(0, service.player.duration.coerceAtLeast(0)))
                        "speed" -> service.player.setPlaybackSpeed(args.optDouble("rate", 1.0).coerceIn(0.5, 2.0).toFloat())
                        else -> control(args.optString("command"))
                    }
                    answer(null)
                }
                "android_queue_cancel" -> { service.queue.cancel(args.optString("ticket")); answer(null) }
                "android_equalizer" -> answer(service.applyEqualizer(args))
                "android_settings" -> { openSettings(); answer(null) }
                "spotify_state" -> spotify.state(args.getString("id")) { answer(it) }
                "spotify_show" -> { spotify.show(args.getString("id")); answer(null) }
                "spotify_close" -> { spotify.close(args.getString("id")); answer(null) }
                "android_open" -> {
                    val uri = Uri.parse(args.optString("url"))
                    if (uri.scheme == "https") open(uri)
                    answer(null)
                }
                else -> work({ answer(null, it) }, priority = command == "android_queue") {
                    runCatching {
                        if (command == "spotify_open") {
                            val user = RustBridge.call("catalog_request", JSONObject().put("request", JSONObject().put("operation", "me"))
                                .put("expectedOwner", args.getLong("owner"))) as JSONObject
                            check(user.getLong("id") == args.getLong("owner")) { "SoundCloud account changed" }
                            main.post { runCatching { spotify.start(args) }.onSuccess { answer(null) }.onFailure { answer(null, it.message) } }
                            return@work
                        }
                        if (command == "android_queue") {
                            val queueRequest = args.getJSONObject("request")
                            val prepared = MediaQueue.resolve(queueRequest)
                            main.post {
                                runCatching { service.queue.apply(queueRequest, prepared) }
                                    .onSuccess { answer(it); pushPlayback() }
                                    .onFailure { answer(null, it.message ?: "Ошибка очереди") }
                            }
                            return@work
                        }
                        if (command == "android_fixture") {
                            check(BuildConfig.DEBUG && fixture)
                            main.post { startFixture(); answer(null) }
                            return@work
                        }
                        check(command in setOf("catalog_request", "wave_sample", "profile_load", "profile_save", "profile_flush",
                            "wave_active", "monitor_ready", "native_diagnostics", "source_request", "source_cancel",
                            "client_options", "listening_status", "listening_update")) { "This operation requires local settings" }
                        if (command == "client_options") check(!args.has("options"))
                        RustBridge.call(command, args)
                    }.onSuccess { value -> main.post { answer(value) } }
                        .onFailure { error -> main.post { answer(null, error.message ?: "Ошибка SoundCloud") } }
                }
            } } catch (error: Exception) { answer(null, error.message ?: "Invalid Android request") }
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(view, bootstrap, setOf("https://soundcloud.com"))
        }
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(webView: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return false
                val uri = request.url
                if (uri.scheme != "https") return true
                val host = uri.host.orEmpty()
                if (host == "soundcloud.com" || host.endsWith(".soundcloud.com") ||
                    host in setOf("accounts.google.com", "appleid.apple.com", "www.facebook.com")) return false
                open(uri)
                return true
            }
            override fun onPageStarted(webView: WebView, url: String, favicon: android.graphics.Bitmap?) {
                onLoading?.invoke(true)
                source = url
                if (Uri.parse(url).host == "soundcloud.com") {
                    if (Uri.parse(url).path == "/sign-out") { service.player.stop(); service.player.clearMediaItems() }
                    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) evaluate(bootstrap)
                    work { runCatching { RustBridge.call("navigation", JSONObject().put("url", url)) } }
                }
            }
            override fun onPageFinished(webView: WebView, url: String) {
                if (Uri.parse(url).host == "soundcloud.com") {
                    evaluate(bootstrap + "\n" + injected); pushPlayback()
                    view.evaluateJavascript("Boolean(document.getElementById('android-open-settings'))") { result -> onLoading?.invoke(result != "true") }
                }
            }
            override fun onReceivedError(webView: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) onLoading?.invoke(true)
            }
            override fun shouldInterceptRequest(webView: WebView, request: WebResourceRequest): WebResourceResponse? {
                if (BuildConfig.DEBUG && fixture && request.url.toString() == "https://soundcloud.com/__android_fixture") {
                    return WebResourceResponse("text/html", "UTF-8", service.assets.open("android-fixture.html"))
                }
                val headers = request.requestHeaders
                val destination = headers.entries.firstOrNull { it.key.equals("Sec-Fetch-Dest", true) }?.value
                val kind = when (destination) {
                    "script" -> "script"; "image" -> "image"; "style" -> "stylesheet"; "font" -> "font"
                    "audio", "video" -> "media"; "document", "iframe" -> "document"; else -> "xmlhttprequest"
                }
                return runCatching {
                    val result = RustBridge.call("resource", JSONObject().put("url", request.url.toString())
                        .put("source", source).put("method", request.method).put("kind", kind)
                        .put("authorization", headers.entries.firstOrNull { it.key.equals("Authorization", true) }?.value ?: "")) as? JSONObject
                        ?: return null
                    WebResourceResponse(result.getString("mime"), "UTF-8", 200, "OK",
                        mapOf("Cache-Control" to "no-store", "Access-Control-Allow-Origin" to "*"),
                        ByteArrayInputStream(Base64.decode(result.getString("body"), Base64.DEFAULT)))
                }.getOrNull()
            }
        }
    }

    private fun work(onFailure: (String) -> Unit = {}, priority: Boolean = false, task: () -> Unit) {
        try { (if (priority) playbackWorkers else workers).execute(task) }
        catch (_: RejectedExecutionException) { main.post { onFailure("Приложение занято. Попробуй ещё раз.") } }
    }
    fun start(testFixture: Boolean) {
        if (started) return
        started = true
        fixture = testFixture
        work {
            runCatching { RustBridge.initialize(service.filesDir.absolutePath) }.onSuccess { config ->
                val preferences = RustBridge.call("client_options") as JSONObject
                main.post {
                applyTextZoom(preferences.optDouble("zoom", 1.0))
                val load = Runnable { view.loadUrl(if (fixture) "https://soundcloud.com/__android_fixture" else "https://soundcloud.com/") }
                val port = config.optInt("port")
                service.proxyPort = port
                if (port > 0 && WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) &&
                    WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE_REVERSE_BYPASS)) {
                    val proxy = ProxyConfig.Builder().addProxyRule("http://127.0.0.1:$port")
                        .addBypassRule("*.soundcloud.com").addBypassRule("soundcloud.com")
                        .addBypassRule("*.sndcdn.com").addBypassRule("sndcdn.com")
                        .addBypassRule("*.media-streaming.soundcloud.cloud")
                        .addBypassRule("*.spotify.com").addBypassRule("*.scdn.co").addBypassRule("*.spotifycdn.com")
                        .setReverseBypassEnabled(true).build()
                    ProxyController.getInstance().setProxyOverride(proxy, Executor { main.post(it) }, load)
                } else load.run()
            } }.onFailure { error -> main.post {
                view.loadDataWithBaseURL(null, "<html><meta name='viewport' content='width=device-width'><body>SoundCloud: " +
                    android.text.Html.escapeHtml(error.message ?: "Не удалось запустить приложение") + "</body></html>", "text/html", "UTF-8", null)
            } }
        }
    }
    fun evaluate(script: String) {
        if (Uri.parse(view.url.orEmpty()).host == "soundcloud.com") view.evaluateJavascript(script, null)
    }
    fun control(command: String) {
        when (command) {
            "toggle" -> if (service.player.isPlaying) {
                evaluate("window.dispatchEvent(new Event('__soundcloudWaveManualPause'))")
                service.player.pause()
            } else service.player.play()
            "next" -> service.player.seekToNext()
            "previous" -> service.player.seekToPrevious()
            "stop" -> { service.player.stop(); service.player.clearMediaItems() }
        }
    }
    fun pushPlayback() {
        if (Looper.myLooper() != Looper.getMainLooper()) { main.post { pushPlayback() }; return }
        val player = service.player
        val seconds = { ms: Long -> val value = (ms / 1000).coerceAtLeast(0); "${value / 60}:${(value % 60).toString().padStart(2, '0')}" }
        val frame = JSONObject().put("title", player.mediaMetadata.title ?: "").put("author", player.mediaMetadata.artist ?: "")
            .put("artwork", player.mediaMetadata.artworkUri?.toString() ?: "")
            .put("url", player.currentMediaItem?.mediaId ?: "").put("isPlaying", player.isPlaying).put("isLiked", false)
            .put("elapsed", seconds(player.currentPosition)).put("duration", seconds(player.duration))
            .put("wantsPlayback", player.playWhenReady).put("ended", player.playbackState == Player.STATE_ENDED)
            .put("suppressed", player.playbackSuppressionReason != Player.PLAYBACK_SUPPRESSION_REASON_NONE)
            .put("playbackRate", player.playbackParameters.speed.toDouble())
        player.playerError?.let { frame.put("error", it.errorCodeName) }
        evaluate("window.__androidPlayback?.($frame)")
    }
    fun attach(activity: Activity, container: FrameLayout) {
        context.baseContext = activity
        (view.parent as? ViewGroup)?.removeView(view)
        container.addView(view, FrameLayout.LayoutParams(-1, -1))
    }
    fun detach(container: FrameLayout) {
        onLoading = null
        settings.close()
        spotify.close()
        if (view.parent === container) container.removeView(view)
        context.baseContext = service
        work { runCatching { RustBridge.call("flush") } }
    }
    fun back(): Boolean {
        if (view.canGoBack()) { view.goBack(); return true }
        return false
    }
    private fun open(uri: Uri) {
        runCatching { service.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }
    fun openExternal(url: String) { val uri = Uri.parse(url); if (uri.scheme == "https" && uri.userInfo == null) open(uri) }
    fun openSettings() {
        work {
            runCatching { RustBridge.initialize(service.filesDir.absolutePath) }
                .onSuccess { main.post { settings.show() } }
        }
    }
    fun setSpeed(rate: Double) { service.player.setPlaybackSpeed(rate.coerceIn(0.5, 2.0).toFloat()) }
    fun applyTextZoom(zoom: Double) { view.settings.textZoom = (zoom.coerceIn(0.75, 1.5) * 100).toInt() }
    fun reload() { service.player.stop(); service.player.clearMediaItems(); view.reload() }
    private fun startFixture() {
        val items = (1..3).map { index ->
            MediaItem.Builder().setMediaId("fixture-$index").setUri("asset:///playback-$index.wav")
                .setMediaMetadata(MediaMetadata.Builder().setTitle("Тестовый трек $index").setArtist("SoundCloud").build()).build()
        }
        service.player.setMediaItems(items); service.player.prepare(); service.player.play()
    }
    fun close() {
        settings.close()
        spotify.close()
        view.stopLoading()
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        work { runCatching {
            RustBridge.call("listening_update", JSONObject().put("track", JSONObject.NULL))
            RustBridge.call("flush")
        } }
        workers.shutdown()
        playbackWorkers.shutdown()
    }
}

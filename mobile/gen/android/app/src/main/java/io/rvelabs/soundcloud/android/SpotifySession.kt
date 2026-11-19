@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import android.app.Activity
import android.app.Dialog
import android.content.MutableContextWrapper
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.webkit.*
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/** Optional, short-lived browser; opened visibly only after the import consent prompt. */
class SpotifySession(private val context: MutableContextWrapper) {
    private var view: WebView? = null
    private var dialog: Dialog? = null
    private var id = ""
    private var playlist = JSONObject()
    private val rows = linkedMapOf<String, Pair<Int, JSONObject>>()
    private var reachable = false
    private var closed = false
    private var busy = false
    private val main = Handler(Looper.getMainLooper())
    private val snapshot by lazy { context.assets.open("android-spotify.js").bufferedReader().use { it.readText() } }

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    fun start(args: JSONObject) {
        check(view == null) { "Spotify import is already running" }
        val url = Uri.parse(args.getString("url"))
        require(url.scheme == "https" && url.host == "open.spotify.com" &&
            url.path.orEmpty().matches(Regex("/(playlist|album)/[A-Za-z0-9]{22}"))) { "Invalid Spotify playlist" }
        id = args.getString("id")
        playlist = JSONObject(args.getJSONObject("initial").toString())
        val initial = playlist.getJSONArray("tracks")
        require(initial.length() <= 500)
        rows.clear(); closed = false; reachable = false
        for (index in 0 until initial.length()) {
            val track = initial.getJSONObject(index)
            rows[track.optString("sourceId", track.optString("artist") + "|" + track.optString("title"))] = index + 1 to track
        }
        view = WebView(context).also { browser ->
            browser.settings.javaScriptEnabled = true
            browser.settings.domStorageEnabled = true
            browser.settings.allowFileAccess = false
            browser.settings.allowContentAccess = false
            browser.settings.mediaPlaybackRequiresUserGesture = true
            browser.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    return request.isForMainFrame && (uri.scheme != "https" || uri.host !in setOf(
                        "open.spotify.com", "accounts.spotify.com", "challenge.spotify.com", "accounts.google.com", "appleid.apple.com"))
                }
                override fun onPageFinished(view: WebView, url: String) {
                    if (Uri.parse(url).host == "open.spotify.com") {
                        reachable = true
                        view.evaluateJavascript(snapshot, null)
                    }
                }
            }
            browser.loadUrl(url.toString())
        }
    }

    fun state(requestId: String, reply: (JSONObject) -> Unit) {
        require(requestId == id) { "Unknown Spotify import" }
        val browser = view
        val report = { JSONObject().put("playlist", playlist).put("reachable", reachable).put("closed", closed) }
        if (browser == null || closed || Uri.parse(browser.url.orEmpty()).host != "open.spotify.com" || busy) {
            reply(report()); return
        }
        busy = true
        var done = false
        val timeout = Runnable { if (!done) { done = true; busy = false; reply(report()) } }
        main.postDelayed(timeout, 1200)
        browser.evaluateJavascript("JSON.stringify(window.SoundCloudSpotify?.spotifySnapshot?.() || {})") { raw ->
            if (done) return@evaluateJavascript
            done = true; busy = false; main.removeCallbacks(timeout)
            if (raw.length <= 1_000_000) runCatching {
                val value = JSONTokener(raw).nextValue() as? String ?: return@runCatching
                val data = JSONObject(value)
                val tracks = data.optJSONArray("tracks") ?: JSONArray()
                require(tracks.length() <= 500)
                for (index in 0 until tracks.length()) {
                    val track = tracks.getJSONObject(index)
                    val source = track.optString("sourceId")
                    if (source.matches(Regex("spotify:track:[A-Za-z0-9]{22}")) &&
                        track.optString("title").length in 1..200 && track.optString("artist").length in 1..200 && rows.size < 500) {
                        rows[source] = track.optInt("position", index + 1).coerceIn(1, 1000000) to track
                    }
                }
                val total = data.optInt("total", playlist.optInt("expectedTracks", 0))
                if (total > 0) playlist.put("expectedTracks", total)
                val ordered = rows.values.sortedBy { it.first }.map { it.second }
                playlist.put("tracks", JSONArray(ordered)).put("readTracks", ordered.size)
                    .put("partial", total == 0 || ordered.size < total)
                    .put("pagesRead", (ordered.size + 49) / 50)
                reachable = reachable || data.optBoolean("reachable")
            }
            reply(report())
        }
    }

    fun show(requestId: String) {
        require(requestId == id)
        val activity = context.baseContext as? Activity ?: error("Return to the app to sign in to Spotify")
        val browser = view ?: error("Spotify import closed")
        if (dialog != null) return
        dialog = Dialog(activity).also { modal ->
            modal.setContentView(browser)
            modal.setOnCancelListener { close(id) }
            modal.show()
            modal.window?.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
    }

    fun close(requestId: String = id) {
        if (requestId != id) return
        closed = true; busy = false
        dialog?.dismiss(); dialog = null
        view?.let { (it.parent as? ViewGroup)?.removeView(it); it.stopLoading(); it.destroy() }
        view = null
    }
}

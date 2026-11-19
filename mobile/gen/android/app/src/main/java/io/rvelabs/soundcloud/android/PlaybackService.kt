package io.rvelabs.soundcloud.android

import android.app.PendingIntent
import android.content.Intent
import android.media.audiofx.Equalizer
import android.os.Binder
import android.os.IBinder
import android.os.Handler
import android.os.Looper
import androidx.media3.common.*
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.*
import androidx.media3.exoplayer.audio.*
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import org.json.JSONObject
import kotlin.math.ln
import kotlin.math.pow
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import okhttp3.OkHttpClient
import java.net.*
import java.io.IOException

@UnstableApi
class PlaybackService : MediaSessionService() {
    inner class LocalBinder : Binder() { val service: PlaybackService get() = this@PlaybackService }
    lateinit var browser: BrowserHost
    lateinit var player: ExoPlayer
    lateinit var queue: MediaQueue
    @Volatile var proxyPort = 0
    private var session: MediaSession? = null
    private var equalizer: Equalizer? = null
    private var eqSettings = JSONObject()
    private val analysis = AudioAnalysis()
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable {
        override fun run() {
            if (::browser.isInitialized) {
                browser.evaluate("void window.__soundcloudNative?.tick()")
                browser.pushPlayback()
                analysis.take()?.let { value ->
                    val path = runCatching { android.net.Uri.parse(player.currentMediaItem?.mediaId).path }.getOrNull()
                    value.put("path", path)
                    value.put("treble", value.optDouble("brightness"))
                    browser.evaluate("window.soundcloudAPI?.sendAudioFeatures($value)")
                }
            }
            handler.postDelayed(this, if (player.isPlaying) 1000 else 4000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        val renderers = object : DefaultRenderersFactory(this) {
            override fun buildAudioSink(context: android.content.Context, floatOutput: Boolean, playbackParams: Boolean): AudioSink =
                DefaultAudioSink.Builder(context).setAudioProcessors(arrayOf(analysis)).build()
        }
        val http = OkHttpClient.Builder().proxySelector(object : ProxySelector() {
            override fun select(uri: URI): List<Proxy> {
                val host = uri.host.orEmpty()
                val eligible = host == "soundcloud.com" || host.endsWith(".soundcloud.com") ||
                    host == "sndcdn.com" || host.endsWith(".sndcdn.com") || host.endsWith(".media-streaming.soundcloud.cloud")
                val port = proxyPort
                return listOf(if (eligible && port > 0) Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", port)) else Proxy.NO_PROXY)
            }
            override fun connectFailed(uri: URI?, address: SocketAddress?, error: IOException?) {}
        }).build()
        val data = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(http))
        player = ExoPlayer.Builder(this, renderers)
            .setMediaSourceFactory(DefaultMediaSourceFactory(this).setDataSourceFactory(data))
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true)
            .setHandleAudioBecomingNoisy(true).setWakeMode(C.WAKE_MODE_LOCAL).build()
        queue = MediaQueue(player)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        session = MediaSession.Builder(this, player).setSessionActivity(open).build()
        browser = BrowserHost(this)
        player.addListener(object : Player.Listener {
            override fun onEvents(player: Player, events: Player.Events) { browser.pushPlayback() }
            override fun onMediaItemTransition(item: MediaItem?, reason: Int) {
                analysis.resetTrack()
                // Keep only a short playback history in memory.
                if (player.currentMediaItemIndex > 8) player.removeMediaItems(0, player.currentMediaItemIndex - 8)
            }
            override fun onAudioSessionIdChanged(audioSessionId: Int) {
                equalizer?.release()
                equalizer = runCatching { Equalizer(0, audioSessionId) }.getOrNull()
                val status = applyEqualizer(eqSettings)
                browser.evaluate("window.__androidEqualizerStatus?.($status)")
            }
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                if (!playWhenReady && reason == Player.PLAY_WHEN_READY_CHANGE_REASON_USER_REQUEST) {
                    browser.evaluate("window.dispatchEvent(new Event('__soundcloudWaveManualPause'))")
                }
            }
        })
        handler.post(tick)
    }

    fun applyEqualizer(value: JSONObject): JSONObject {
        eqSettings = value
        val effect = equalizer ?: return JSONObject().put("status", "waiting").put("reason", "native-connecting")
        return runCatching {
            val enabled = value.optBoolean("enabled")
            effect.enabled = enabled
            val frequencies = doubleArrayOf(31.0, 63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0, 16000.0)
            val gains = value.optJSONArray("gains")
            val min = effect.bandLevelRange[0].toInt()
            val max = effect.bandLevelRange[1].toInt()
            var headroom = 0.0
            for (band in 0 until effect.numberOfBands.toInt()) {
                val frequency = effect.getCenterFreq(band.toShort()) / 1000.0
                val upper = frequencies.indexOfFirst { it >= frequency }.let { if (it < 0) frequencies.lastIndex else it }
                val lower = (upper - 1).coerceAtLeast(0)
                val ratio = if (lower == upper) 0.0 else
                    (ln(frequency / frequencies[lower]) / ln(frequencies[upper] / frequencies[lower])).coerceIn(0.0, 1.0)
                val gain = (gains?.optDouble(lower, 0.0) ?: 0.0) * (1 - ratio) +
                    (gains?.optDouble(upper, 0.0) ?: 0.0) * ratio
                effect.setBandLevel(band.toShort(), (gain * 100).toInt().coerceIn(min, max).toShort())
                headroom = maxOf(headroom, gain)
            }
            player.volume = if (enabled) 10.0.pow((value.optDouble("preamp", 0.0).coerceIn(-18.0, 0.0) -
                headroom.coerceAtLeast(0.0)) / 20).coerceIn(0.0, 1.0).toFloat() else 1.0f
            JSONObject().put("status", if (enabled) "active" else "off").put("headroomDb", headroom)
                .put("nativeBands", effect.numberOfBands.toInt())
        }.getOrElse { JSONObject().put("status", "unavailable").put("reason", "native-effect") }
    }

    override fun onGetSession(info: MediaSession.ControllerInfo): MediaSession? =
        if (info.isTrusted || info.packageName == packageName) session else null
    override fun onBind(intent: Intent?): IBinder? =
        if (intent?.action == "io.rvelabs.soundcloud.BIND_UI") LocalBinder() else super.onBind(intent)

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        browser.close()
        equalizer?.release()
        player.release()
        session?.release()
        super.onDestroy()
    }
}

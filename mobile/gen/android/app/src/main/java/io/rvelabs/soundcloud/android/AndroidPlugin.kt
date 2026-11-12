package io.rvelabs.soundcloud.android

import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.session.MediaController
import androidx.media3.session.SessionToken
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.common.util.concurrent.ListenableFuture

@InvokeArg
class ActionArgs {
    lateinit var action: String
}

@TauriPlugin
class AndroidPlugin(private val host: Activity) : Plugin(host) {
    private var controller: ListenableFuture<MediaController>? = null

    @Command
    fun action(invoke: Invoke) {
        val action = invoke.parseArgs(ActionArgs::class.java).action
        host.runOnUiThread {
            if (action == "openCatalog") {
                runCatching { host.startActivity(Intent(host, CatalogActivity::class.java)) }
                    .onSuccess { invoke.resolve() }
                    .onFailure { invoke.reject("Не удалось открыть SoundCloud") }
                return@runOnUiThread
            }
            val token = SessionToken(host, ComponentName(host, PlaybackService::class.java))
            val pending = controller ?: MediaController.Builder(host, token).buildAsync().also { controller = it }
            pending.addListener({
                try {
                    val player = pending.get()
                    when (action) {
                        "startFixture" -> {
                            player.setMediaItems((1..3).map(::fixture))
                            player.prepare()
                            player.play()
                        }
                        "play" -> {
                            if (player.playbackState == Player.STATE_ENDED) player.seekToDefaultPosition(0)
                            player.play()
                        }
                        "pause" -> player.pause()
                        "previous" -> player.seekToPrevious()
                        "next" -> player.seekToNext()
                        "stop" -> {
                            player.stop()
                            player.clearMediaItems()
                        }
                    }
                    val state = JSObject()
                    state.put("count", player.mediaItemCount)
                    state.put("index", player.currentMediaItemIndex)
                    state.put("title", player.mediaMetadata.title?.toString() ?: "")
                    state.put("playing", player.playWhenReady && player.playbackState != Player.STATE_ENDED)
                    state.put("ended", player.playbackState == Player.STATE_ENDED)
                    player.playerError?.let { state.put("error", it.errorCodeName) }
                    invoke.resolve(state)
                } catch (error: Exception) {
                    if (controller === pending) {
                        controller = null
                        MediaController.releaseFuture(pending)
                    }
                    invoke.reject("Не удалось подключиться к плееру", error)
                }
            }, ContextCompat.getMainExecutor(host))
        }
    }

    override fun onDestroy() {
        controller?.let(MediaController::releaseFuture)
        controller = null
    }

    private fun fixture(index: Int): MediaItem = MediaItem.Builder()
        .setMediaId("fixture-$index")
        .setUri("asset:///playback-$index.wav")
        .setMediaMetadata(MediaMetadata.Builder().setTitle("Тестовый трек $index").setArtist("SoundCloud").build())
        .build()
}

@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import org.json.JSONArray
import org.json.JSONObject

/** All mutations run on the Android main thread after stream resolution has completed. */
class MediaQueue(private val player: Player) {
    private val cancelled = LinkedHashSet<String>()

    fun cancel(ticket: String) {
        cancelled.add(ticket)
        while (cancelled.size > 256) cancelled.remove(cancelled.first())
    }

    fun future(): List<String> = ((player.currentMediaItemIndex + 1).coerceAtLeast(0) until player.mediaItemCount)
        .map { player.getMediaItemAt(it).mediaId }

    fun apply(request: JSONObject, items: List<MediaItem>): JSONObject {
        val ticket = request.getString("ticket")
        if (cancelled.remove(ticket) || System.currentTimeMillis() >= request.optLong("expires")) {
            return JSONObject().put("state", "cancelled")
        }
        val operation = request.getString("operation")
        val urls = request.getJSONArray("urls").strings()
        request.optJSONObject("replacement")?.let { replacement ->
            val current = player.currentMediaItem?.mediaId
            if (current != replacement.getString("current") || future() != replacement.getJSONArray("expected").strings()) {
                return JSONObject().put("state", "uncertain")
            }
            remove(replacement.getJSONArray("remove").strings())
        }
        when (operation) {
            "play" -> {
                if (items.isEmpty()) return JSONObject().put("state", "unavailable")
                player.setMediaItems(items)
                player.prepare()
                player.play()
            }
            "add" -> {
                val present = (0 until player.mediaItemCount).map { player.getMediaItemAt(it).mediaId }.toSet()
                player.addMediaItems(items.filter { it.mediaId !in present })
            }
            "remove" -> remove(urls)
            "list" -> {}
            else -> throw IllegalArgumentException("Unknown queue operation")
        }
        return JSONObject().put("state", "done").put("urls", JSONArray(if (operation == "play") items.map { it.mediaId } else future()))
    }

    private fun remove(urls: List<String>) {
        for (index in (player.mediaItemCount - 1) downTo (player.currentMediaItemIndex + 1).coerceAtLeast(0)) {
            if (player.getMediaItemAt(index).mediaId in urls) player.removeMediaItem(index)
        }
    }

    companion object {
        fun resolve(request: JSONObject): List<MediaItem> {
            val urls = request.getJSONArray("urls")
            require(urls.length() <= 6) { "Queue request exceeds capacity" }
            if (request.getString("operation") !in listOf("play", "add")) return emptyList()
            return (0 until urls.length()).map { index ->
                val value = RustBridge.call("playback_stream", JSONObject().put("url", urls.getString(index))
                    .put("owner", request.opt("owner") ?: JSONObject.NULL)) as JSONObject
                val track = value.getJSONObject("metadata")
                val title = track.optString("title")
                val artist = track.optString("author")
                val metadata = MediaMetadata.Builder().setTitle(title).setArtist(artist)
                val art = track.optString("artwork")
                if (art.startsWith("https://")) metadata.setArtworkUri(Uri.parse(art))
                MediaItem.Builder().setMediaId(urls.getString(index)).setUri(value.getString("stream"))
                    .setMediaMetadata(metadata.build()).build()
            }
        }
    }
}

fun JSONArray.strings(): List<String> = (0 until length()).map(::getString)

@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.exoplayer.ExoPlayer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.sin

@RunWith(AndroidJUnit4::class)
class AndroidCoreTest {
    @Test fun cancelledAndStaleQueueRequestsDoNotChangePlayback() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            val player = ExoPlayer.Builder(instrumentation.targetContext).build()
            try {
                val queue = MediaQueue(player)
                val current = MediaItem.fromUri("asset:///playback-1.wav").buildUpon().setMediaId("current").build()
                val next = current.buildUpon().setMediaId("next").build()
                player.setMediaItems(listOf(current, next))
                val request = JSONObject().put("operation", "play").put("urls", JSONArray().put("replacement"))
                    .put("ticket", "cancelled").put("expires", System.currentTimeMillis() + 10000)
                queue.cancel("cancelled")
                assertEquals("cancelled", queue.apply(request, listOf(next)).getString("state"))
                assertEquals("current", player.currentMediaItem!!.mediaId)
                request.put("ticket", "stale").put("operation", "add")
                    .put("replacement", JSONObject().put("current", "wrong").put("expected", JSONArray().put("next"))
                        .put("remove", JSONArray().put("next")))
                assertEquals("uncertain", queue.apply(request, listOf(next)).getString("state"))
                assertEquals(listOf("next"), queue.future())
                request.put("ticket", "expired").put("expires", 1)
                assertEquals("cancelled", queue.apply(request, listOf(next)).getString("state"))
            } finally { player.release() }
        }
    }

    @Test fun pcmAnalysisRequiresThirtySecondsAndPassesAudioUnchanged() {
        val analysis = AudioAnalysis()
        analysis.configure(AudioFormat(8000, 1, C.ENCODING_PCM_16BIT))
        analysis.flush()
        repeat(30) { second ->
            val bytes = ByteArray(16000)
            val samples = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
            repeat(8000) { frame -> samples.putShort((10000 * sin(2 * PI * 100 * frame / 8000)).toInt().toShort()) }
            val input = ByteBuffer.allocateDirect(bytes.size).order(ByteOrder.nativeOrder()).put(bytes)
            input.flip()
            analysis.queueInput(input)
            val output = analysis.output
            val actual = ByteArray(output.remaining()); output.get(actual)
            assertArrayEquals(bytes, actual)
            if (second < 29) assertNull(analysis.take())
        }
        val features = analysis.take()!!
        assertEquals("android-pcm-v1", features.getString("source"))
        assertEquals(30, features.getInt("sampleSeconds"))
        assertTrue(features.getDouble("energy") in 0.1..0.5)
        assertTrue(features.getDouble("bass") > features.getDouble("brightness"))
        assertNull(analysis.take())
    }

    @Test fun rustHostAndAndroidKeystoreRoundTrip() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        RustBridge.initialize(context.filesDir.absolutePath)
        val status = RustBridge.call("native_diagnostics") as JSONObject
        assertEquals("0.2.15", status.getString("version"))
        val settingsFile = File(context.filesDir, "native-connection.dat")
        RustBridge.call("connection_save", JSONObject().put("mode", "off").put("endpoint", "").put("key", ""))
        assertTrue("Rust must persist through the Java Keystore bridge", settingsFile.exists())
        assertFalse(String(settingsFile.readBytes()).contains("endpoint"))
        assertEquals("off", (RustBridge.call("connection_load") as JSONObject).getString("mode"))
        settingsFile.delete()
        val file = File(context.cacheDir, "keystore-test.dat")
        try {
            val secret = "test-fixture-not-a-real-key".toByteArray()
            SecretStorage.crypt(file.path, secret, true)
            assertArrayEquals(secret, SecretStorage.crypt(file.path, byteArrayOf(), false))
            assertFalse(String(file.readBytes()).contains(String(secret)))
            val bytes = file.readBytes(); bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte(); file.writeBytes(bytes)
            assertTrue(runCatching { SecretStorage.crypt(file.path, byteArrayOf(), false) }.isFailure)
        } finally { file.delete() }
    }
}

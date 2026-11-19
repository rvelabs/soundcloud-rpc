@file:androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)

package io.rvelabs.soundcloud.android

import androidx.media3.common.C
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicReference

/** Samples a bounded 30 seconds from PCM buffers already decoded by ExoPlayer. */
class AudioAnalysis : BaseAudioProcessor() {
    private var samples = 0L
    private var total = 0.0
    private var bass = 0.0
    private var treble = 0.0
    private var low = 0.0
    private val ready = AtomicReference<JSONObject?>(null)
    @Volatile private var resetRequested = true

    fun resetTrack() { resetRequested = true }
    fun take(): JSONObject? = ready.getAndSet(null)

    override fun onConfigure(input: AudioFormat): AudioFormat {
        if (input.encoding != C.ENCODING_PCM_16BIT) return AudioFormat.NOT_SET
        return input
    }

    override fun queueInput(input: ByteBuffer) {
        val output = replaceOutputBuffer(input.remaining())
        if (resetRequested) {
            samples = 0; total = 0.0; bass = 0.0; treble = 0.0; low = 0.0
            ready.set(null); resetRequested = false
        }
        if (samples < inputAudioFormat.sampleRate.toLong() * 30) {
            val view = input.duplicate().order(ByteOrder.LITTLE_ENDIAN)
            val channels = inputAudioFormat.channelCount.coerceAtLeast(1)
            val alpha = (1.0 - kotlin.math.exp(-2 * Math.PI * 180 / inputAudioFormat.sampleRate))
            while (view.remaining() >= channels * 2 && samples < inputAudioFormat.sampleRate.toLong() * 30) {
                var sample = 0.0
                repeat(channels) { sample += view.short / 32768.0 }
                sample /= channels
                low += alpha * (sample - low)
                total += sample * sample
                bass += low * low
                treble += (sample - low) * (sample - low)
                samples++
            }
            if (samples >= inputAudioFormat.sampleRate.toLong() * 30 && total > 0.0001) {
                val spectrum = (bass + treble).coerceAtLeast(0.0001)
                ready.set(JSONObject().put("energy", sqrt(total / samples).coerceIn(0.0, 1.0))
                    .put("bass", bass / spectrum).put("brightness", treble / spectrum)
                    .put("sampleSeconds", 30).put("source", "android-pcm-v1"))
            }
        }
        output.put(input).flip()
    }
}
